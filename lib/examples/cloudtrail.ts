import { ApiFactory } from '../client/mod.ts';
import { CloudTrail } from 'https://aws-api.danopia.deno.net/v0.3/services/cloudtrail.ts';
const cloudTrail = new ApiFactory().makeNew(CloudTrail);

// Fetch most recent non-readonly operations from past 90 days
const { Events } = await cloudTrail.lookupEvents({
  LookupAttributes: [{
    AttributeKey: 'ReadOnly',
    AttributeValue: 'false',
  }]
});

// Print a subset of fields in a table
console.table(Events?.map(x => ({
  Username: x.Username,
  API: x.EventName,
  Timestamp: x.EventTime,
})));
