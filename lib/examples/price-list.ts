/**
 * Download storage volume prices for EC2 from the Pricing API
 * This API returns 'raw JSON' so there are no type definitions in the API definitions.
 * That makes this example unusually ugly; hopefully it's still potentially useful.
 */

import { ApiFactory } from '../client/mod.ts';
import { Pricing } from 'https://aws-api.danopia.deno.net/v0.3/services/pricing.ts';

const pricing = new ApiFactory().makeNew(Pricing);

const ec2Pricing = await pricing.getAttributeValues({
  ServiceCode: 'AmazonEC2',
  AttributeName: 'volumeType',
});
const volumeTypes = ec2Pricing.AttributeValues?.map(x => x.Value) ?? [];
console.log('Available EC2 volume types:', volumeTypes);

const priceLists = await Promise.all(volumeTypes.map(x => pricing.getProducts({
  ServiceCode: "AmazonEC2",
  FormatVersion: "aws_v1",
  Filters: [{
    Field: "volumeType",
    Type: "TERM_MATCH",
    Value: `${x}`,
  }],
}).then(y => y.PriceList)));

console.table(priceLists.flat(1).map(x => {
  const onDemand = Object.values((x as any).terms.OnDemand)[0] as any;
  const dimension = Object.values(onDemand?.priceDimensions)[0] as any;
  return {
    VolumeType: (x as any).product.attributes.volumeType,
    Location: (x as any).product.attributes.location,
    Price: Object.values(dimension?.pricePerUnit)[0],
    Currency: Object.keys(dimension?.pricePerUnit)[0],
    Unit: dimension?.unit,
  };
}));
