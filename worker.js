const hubspot = require('@hubspot/api-client');
const { queue } = require('async');
const _ = require('lodash');

const { filterNullValuesFromObject, goal, actionsToSave } = require('./utils');
const Domain = require('./Domain');
const Action = require('./Action');

const hubspotClient = new hubspot.Client({ accessToken: '' });

// Bug: remove dead code
// const propertyPrefix = 'hubspot__';
let expirationDate;

// Bug:
// typo error here, which GTQ was not a supported operator
// and bcoz of this the results were not fetched
// add error handling here
const generateLastModifiedDateFilter = (date, nowDate, propertyName = 'hs_lastmodifieddate') => {
  const lastModifiedDateFilter = date
    ? {
        filters: [
          { propertyName, operator: 'GTE', value: `${date.valueOf()}` },
          { propertyName, operator: 'LTE', value: `${nowDate.valueOf()}` },
        ],
      }
    : {};

  return lastModifiedDateFilter;
};

const saveDomain = async (domain) => {
  // disable this for testing purposes
  // console.log({ domain });
  return;

  domain.markModified('integrations.hubspot.accounts');
  await domain.save();
};

/**
 * Get access token from HubSpot
 */
const refreshAccessToken = async (domain, hubId, tryCount) => {
  const { HUBSPOT_CID, HUBSPOT_CS } = process.env;
  const account = domain.integrations.hubspot.accounts.find((account) => account.hubId === hubId);
  const { accessToken, refreshToken } = account;

  return hubspotClient.oauth.tokensApi
    .createToken('refresh_token', undefined, undefined, HUBSPOT_CID, HUBSPOT_CS, refreshToken)
    .then(async (result) => {
      const body = result.body ? result.body : result;

      const newAccessToken = body.accessToken;
      expirationDate = new Date(body.expiresIn * 1000 + new Date().getTime());

      hubspotClient.setAccessToken(newAccessToken);
      if (newAccessToken !== accessToken) {
        account.accessToken = newAccessToken;
      }

      return true;
    });
};

/**
 * Get recently modified companies as 100 companies per page
 */
const processCompanies = async (domain, hubId, q) => {
  const account = domain.integrations.hubspot.accounts.find((account) => account.hubId === hubId);
  const lastPulledDate = new Date(account.lastPulledDates.companies);
  const now = new Date();

  let hasMore = true;
  const offsetObject = {};
  const limit = 100;

  while (hasMore) {
    const lastModifiedDate = offsetObject.lastModifiedDate || lastPulledDate;
    const lastModifiedDateFilter = generateLastModifiedDateFilter(lastModifiedDate, now);
    const searchObject = {
      filterGroups: [lastModifiedDateFilter],
      sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'ASCENDING' }],
      properties: [
        'name',
        'domain',
        'country',
        'industry',
        'description',
        'annualrevenue',
        'numberofemployees',
        'hs_lead_status',
      ],
      limit,
      after: offsetObject.after,
    };

    let searchResult = {};

    let tryCount = 0;
    while (tryCount <= 4) {
      try {
        searchResult = await hubspotClient.crm.companies.searchApi.doSearch(searchObject);
        break;
      } catch (err) {
        tryCount++;

        if (new Date() > expirationDate) await refreshAccessToken(domain, hubId);

        await new Promise((resolve, reject) => setTimeout(resolve, 5000 * Math.pow(2, tryCount)));
      }
    }

    if (!searchResult) throw new Error('Failed to fetch companies for the 4th time. Aborting.');

    const data = searchResult?.results || [];
    offsetObject.after = parseInt(searchResult?.paging?.next?.after);

    console.log('fetch company batch');

    data.forEach((company) => {
      if (!company.properties) return;

      const actionTemplate = {
        includeInAnalytics: 0,
        companyProperties: {
          company_id: company.id,
          company_domain: company.properties.domain,
          company_industry: company.properties.industry,
        },
      };

      const isCreated = !lastPulledDate || new Date(company.createdAt) > lastPulledDate;

      q.push({
        actionName: isCreated ? 'Company Created' : 'Company Updated',
        actionDate: new Date(isCreated ? company.createdAt : company.updatedAt) - 2000,
        ...actionTemplate,
      });
    });

    if (!offsetObject?.after) {
      hasMore = false;
      break;
    } else if (offsetObject?.after >= 9900) {
      offsetObject.after = 0;
      offsetObject.lastModifiedDate = new Date(data[data.length - 1].updatedAt).valueOf();
    }
  }

  account.lastPulledDates.companies = now;
  await saveDomain(domain);

  return true;
};

/**
 * Get recently modified contacts as 100 contacts per page
 */
const processContacts = async (domain, hubId, q) => {
  const account = domain.integrations.hubspot.accounts.find((account) => account.hubId === hubId);
  const lastPulledDate = new Date(account.lastPulledDates.contacts);
  const now = new Date();

  let hasMore = true;
  const offsetObject = {};
  const limit = 100;

  while (hasMore) {
    const lastModifiedDate = offsetObject.lastModifiedDate || lastPulledDate;
    // Bug: error in filter method
    const lastModifiedDateFilter = generateLastModifiedDateFilter(lastModifiedDate, now, 'lastmodifieddate');
    const searchObject = {
      filterGroups: [lastModifiedDateFilter],
      sorts: [{ propertyName: 'lastmodifieddate', direction: 'ASCENDING' }],
      properties: [
        'firstname',
        'lastname',
        'jobtitle',
        'email',
        'hubspotscore',
        'hs_lead_status',
        'hs_analytics_source',
        'hs_latest_source',
      ],
      limit,
      after: offsetObject.after,
    };

    let searchResult = {};

    let tryCount = 0;
    while (tryCount <= 4) {
      try {
        searchResult = await hubspotClient.crm.contacts.searchApi.doSearch(searchObject);
        break;
      } catch (err) {
        tryCount++;
        console.log(`[processContacts]: error processing contacts ${err.message} stack ${err.stack}`);

        if (new Date() > expirationDate) await refreshAccessToken(domain, hubId);
        // Bug: not a bug but use _ instead of reject if we're not using reject to make it more clear
        await new Promise((resolve, reject) => setTimeout(resolve, 5000 * Math.pow(2, tryCount)));
      }
    }

    if (!searchResult) throw new Error('Failed to fetch contacts for the 4th time. Aborting.');

    const data = searchResult.results || [];

    offsetObject.after = parseInt(searchResult.paging?.next?.after);
    const contactIds = data.map((contact) => contact.id);

    // contact to company association
    const contactsToAssociate = contactIds;
    const companyAssociationsResults =
      (
        await (
          await hubspotClient.apiRequest({
            method: 'post',
            path: '/crm/v3/associations/CONTACTS/COMPANIES/batch/read',
            body: { inputs: contactsToAssociate.map((contactId) => ({ id: contactId })) },
          })
        ).json()
      )?.results || [];

    const companyAssociations = Object.fromEntries(
      companyAssociationsResults
        .map((a) => {
          if (a.from) {
            contactsToAssociate.splice(contactsToAssociate.indexOf(a.from.id), 1);
            return [a.from.id, a.to[0].id];
          } else return false;
        })
        .filter((x) => x)
    );

    data.forEach((contact) => {
      if (!contact.properties || !contact.properties.email) return;

      const companyId = companyAssociations[contact.id];

      const isCreated = new Date(contact.createdAt) > lastPulledDate;

      const userProperties = {
        company_id: companyId,
        contact_name: ((contact.properties.firstname || '') + ' ' + (contact.properties.lastname || '')).trim(),
        contact_title: contact.properties.jobtitle,
        contact_source: contact.properties.hs_analytics_source,
        contact_status: contact.properties.hs_lead_status,
        contact_score: parseInt(contact.properties.hubspotscore) || 0,
      };

      const actionTemplate = {
        includeInAnalytics: 0,
        identity: contact.properties.email,
        userProperties: filterNullValuesFromObject(userProperties),
      };

      q.push({
        actionName: isCreated ? 'Contact Created' : 'Contact Updated',
        actionDate: new Date(isCreated ? contact.createdAt : contact.updatedAt),
        ...actionTemplate,
      });
    });

    if (!offsetObject?.after) {
      hasMore = false;
      break;
    } else if (offsetObject?.after >= 9900) {
      offsetObject.after = 0;
      offsetObject.lastModifiedDate = new Date(data[data.length - 1].updatedAt).valueOf();
    }
  }

  account.lastPulledDates.contacts = now;
  await saveDomain(domain);

  return true;
};

const createQueue = (domain, actions) => {
  return queue(async (action, callback) => {
    actions.push(action);

    // Bug: any specific reason to put number as 2000?
    // if (actions.length > 2000) {
    if (actionsToSave.indexOf(action.actionName) !== -1) {
      goal(action, Action);
    }

    callback();
  }, 100000000);
};

const drainQueue = async (domain, actions, q) => {
  if (q.length() > 0) await q.drain();

  // Bug: why do we have actions in drain method
  // why are we sending this to goal if the items in queue are processed and drained?
  // if (actions.length > 0) {
  //   goal(actions);
  // }

  return true;
};

const processMeetings = async (domain, hubId, q) => {
  const account = domain.integrations.hubspot.accounts.find((account) => account.hubId === hubId);
  const lastPulledDate = new Date(account.lastPulledDates.meetings || 0);
  const now = new Date();

  let hasMore = true;
  const offsetObject = {};
  const limit = 100;

  while (hasMore) {
    const lastModifiedDate = offsetObject.lastModifiedDate || lastPulledDate;
    const lastModifiedDateFilter = generateLastModifiedDateFilter(lastModifiedDate, now, 'hs_lastmodifieddate');

    const searchObject = {
      filterGroups: [lastModifiedDateFilter],
      sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'ASCENDING' }],
      properties: ['hs_meeting_title', 'hs_meeting_outcome', 'hs_createdate', 'hs_lastmodifieddate'],
      limit,
      after: offsetObject.after,
    };

    let searchResult = {};

    let tryCount = 0;
    while (tryCount <= 4) {
      try {
        searchResult = await hubspotClient.crm.objects.meetings.searchApi.doSearch(searchObject);
        break;
      } catch (err) {
        tryCount++;
        console.log(`[processMeetings]: error processing meetings ${err.message} stack ${err.stack}`);

        if (new Date() > expirationDate) await refreshAccessToken(domain, hubId);

        await new Promise((resolve, reject) => setTimeout(resolve, 5000 * Math.pow(2, tryCount)));
      }
    }

    if (!searchResult) throw new Error('Failed to fetch meetings for the 4th time. Aborting.');

    const data = searchResult?.results || [];

    console.log('fetch meeting batch');

    offsetObject.after = parseInt(searchResult?.paging?.next?.after);

    for (const meeting of data) {
      if (!meeting.properties) continue;

      try {
        const associatedContacts = await hubspotClient.crm.objects.meetings.associationsApi.getAll(
          meeting.id,
          'contacts'
        );
        const contactIds = associatedContacts.results.map((assoc) => assoc.toObjectId);

        if (contactIds.length === 0) continue;

        const contactDetails = await hubspotClient.crm.contacts.batchApi.read({
          inputs: contactIds.map((id) => ({ id: id.toString() })),
        });

        const contactEmails = contactDetails.results
          .filter((contact) => contact.properties && contact.properties.email)
          .map((contact) => contact.properties.email);

        if (contactEmails.length === 0) continue;

        const isCreated = !lastPulledDate || new Date(meeting.createdAt) > lastPulledDate;

        const actionTemplate = {
          includeInAnalytics: 0,
          meetingProperties: {
            meetingId: meeting.id,
            meetingTitle: meeting.properties.hs_meeting_title,
            createDate: meeting.properties.hs_createdate,
            lastModifiedDate: meeting.properties.hs_lastmodifieddate,
            contactEmails: contactEmails,
          },
        };

        q.push({
          actionName: isCreated ? 'Meeting Created' : 'Meeting Updated',
          actionDate: new Date(isCreated ? meeting.createdAt : meeting.updatedAt),
          ...actionTemplate,
        });
      } catch (error) {
        console.error(`Error processing meeting ${meeting.id}:`, error);
      }
    }

    if (!offsetObject?.after) {
      hasMore = false;
      break;
    } else if (offsetObject?.after >= 9900) {
      offsetObject.after = 0;
      offsetObject.lastModifiedDate = new Date(data[data.length - 1].updatedAt).valueOf();
    }
  }

  account.lastPulledDates.meetings = now;
  await saveDomain(domain);

  return true;
};

const pullDataFromHubspot = async () => {
  console.log('start pulling data from HubSpot');

  const domain = await Domain.findOne({});

  // Bug: why are we not validating account.hubId? Added now
  for (const account of domain.integrations.hubspot.accounts) {
    if (!account.hubId) {
      continue;
    }
    try {
      await refreshAccessToken(domain, account.hubId);
    } catch (err) {
      console.log(err, { apiKey: domain.apiKey, metadata: { operation: 'refreshAccessToken' } });
    }

    const actions = [];
    // Bug: why do we need domain in queue, if we're not using it?
    const q = createQueue(domain, actions);

    try {
      await processContacts(domain, account.hubId, q);
      console.log('process contacts');
    } catch (err) {
      console.log(err, { apiKey: domain.apiKey, metadata: { operation: 'processContacts', hubId: account.hubId } });
    }

    try {
      await processCompanies(domain, account.hubId, q);
      console.log('process companies');
    } catch (err) {
      console.log(err, { apiKey: domain.apiKey, metadata: { operation: 'processCompanies', hubId: account.hubId } });
    }

    if (account?.hubId) {
      try {
        await processMeetings(domain, account.hubId, q);
        console.log('process meetings');
      } catch (err) {
        console.log(err, { apiKey: domain.apiKey, metadata: { operation: 'processMeetings', hubId: account.hubId } });
      }
    }

    try {
      await drainQueue(domain, actions, q);
      console.log('drain queue');
    } catch (err) {
      console.log(err, { apiKey: domain.apiKey, metadata: { operation: 'drainQueue', hubId: account.hubId } });
    }

    await saveDomain(domain);

    console.log('finish processing account');
  }

  process.exit();
};

module.exports = pullDataFromHubspot;
