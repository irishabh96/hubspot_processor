const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const meetingPropertiesSchema = new Schema(
  {
    meetingId: {
      type: String,
      required: true,
    },
    meetingTitle: {
      type: String,
      required: false,
      default: null,
    },
    createDate: {
      type: Date,
      required: true,
    },
    lastModifiedDate: {
      type: Date,
      required: true,
    },
    contactEmails: {
      type: [String],
      default: [],
    },
  },
  { minimize: false }
);

const actionSchema = new mongoose.Schema(
  {
    actionName: {
      type: String,
      required: true,
    },
    actionDate: {
      type: Date,
      required: true,
    },
    includeInAnalytics: {
      type: Number,
      enum: [0, 1],
      default: 0,
    },
    meetingProperties: {
      type: meetingPropertiesSchema,
      required: true,
    },
  },
  { timestamps: true, minimize: false }
);

module.exports = mongoose.model('Action', actionSchema);
