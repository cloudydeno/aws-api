#!/usr/bin/env -S deno run --allow-env --allow-read=${HOME}/.aws --allow-net

import { ApiFactory } from '@cloudydeno/aws-api/client';

const factory = new ApiFactory();
await factory.ensureCredentialsAvailable();

// See aws-api.yaml for the configuration that generates the referenced modules

import { STS } from './lib/sts.ts';

const sts = new STS(factory);
await sts.getCallerIdentity().then(identity => {
  console.log('You are', identity.UserId, 'in account', identity.Account);
  console.log('ARN:', identity.Arn);
}).catch(console.log);


import { EC2 } from './lib/ec2.ts';
const ec2 = new EC2(factory);
console.log(await ec2.describeInstances().then(x => x.Reservations).catch(err => err));


import { SQS } from './lib/sqs.ts';
const sqs = new SQS(factory);
console.log(await sqs.listQueues().catch(err => err));


import { SNS } from './lib/sns.ts';
const sns = new SNS(factory);
console.log(await sns.listTopics().catch(err => err));


import { S3 } from './lib/s3.ts';
const s3 = new S3(factory);
console.log(await s3.listBuckets().catch(err => err));
