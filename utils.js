const disallowedValues = [
  '[not provided]',
  'placeholder',
  '[[unknown]]',
  'not set',
  'not provided',
  'unknown',
  'undefined',
  'n/a',
];

const actionsToSave = ['Meeting Updated', 'Meeting Created'];

const filterNullValuesFromObject = (object) =>
  Object.fromEntries(
    Object.entries(object).filter(
      ([_, v]) =>
        v !== null &&
        v !== '' &&
        typeof v !== 'undefined' &&
        (typeof v !== 'string' || !disallowedValues.includes(v.toLowerCase()) || !v.toLowerCase().includes('!$record'))
    )
  );

const normalizePropertyName = (key) =>
  key
    .toLowerCase()
    .replace(/__c$/, '')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');

const goal = async (actions, ActionDb) => {
  await ActionDb.insertMany(actions);
  // this is where the data will be written to the database
  // console.log(actions);
};

module.exports = {
  filterNullValuesFromObject,
  normalizePropertyName,
  goal,
  actionsToSave,
};
