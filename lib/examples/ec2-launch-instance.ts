#!/usr/bin/env -S deno run --allow-env --allow-read=${HOME}/.aws --allow-net

// Running this script can cost money!
// It also terminates EC2 instances from your region!!
//     (Hopefully only instances that it launched :)
// Please check that all instances are cleaned up after you're done
const ThisScriptUrl = `https://deno.land/x/aws_api/examples/ec2-launch-instance.ts`;

import { ApiFactory } from '../client/mod.ts';
import { EC2, Instance } from 'https://aws-api.danopia.deno.net/v0.3/services/ec2.ts?actions=RunInstances,DescribeInstances,DescribeAvailabilityZones,DescribeVpcs,DescribeSubnets,DescribeImages,TerminateInstances,GetConsoleOutput';

const ec2 = new ApiFactory().makeNew(EC2);

// List at most 25 running EC2 instances in the region
// This uses a .then() pattern to process the results before assigning any variable
console.log('Checking that the EC2 account is acceptable...');
const activeInstances = await ec2
  .describeInstances({ MaxResults: 25 })
  .then(resp => resp.Reservations
    .flatMap(x => x.Instances ?? [])
    .filter(x => x.State?.Name !== 'terminated'));

// Allow checking for / terminating instances that we left laying around previously
if (Deno.args.includes('--cleanup')) {
  await performCleanup(activeInstances);
  Deno.exit(0);
}

// Cowardly refuse to run in accounts with a bunch of stuff going on
if (activeInstances.length > 5) throw new Error(
  `This AWS account has multiple other instances running, so I'm leaving it alone.`);

// Pick an AZ from what's available
const {AvailabilityZones} = await ec2.describeAvailabilityZones();
const firstZone = Deno.env.get('AWS_EC2_ZONE') ?? AvailabilityZones[0]?.ZoneName;
if (!firstZone) throw new Error(
  `I couldn't find an availability zone in this account. Weird.`);
console.log('Using AZ', firstZone,
  '- to use a different zone, export AWS_EC2_ZONE=[...]');

// Find the default VPC
// This will fail if you deleted yours, but most casual users won't
const {Vpcs} = await ec2.describeVpcs({
  Filters: [
    { Name: 'isDefault', Values: ['true'] },
  ],
});
const defaultVpc = Vpcs[0];
if (!defaultVpc?.VpcId) throw new Error(
  `I couldn't find the default VPC in this account. Weird.`);
console.log('Using VPC', defaultVpc.VpcId);

// Find the default subnet in that VPC for the AZ we picked
const {Subnets} = await ec2.describeSubnets({
  Filters: [
    { Name: 'default-for-az', Values: ['true'] },
    { Name: 'vpc-id', Values: [defaultVpc.VpcId] },
    { Name: 'availability-zone', Values: [firstZone] },
  ],
});
const defaultSubnet = Subnets[0];
if (!defaultSubnet?.SubnetId) throw new Error(
  `I couldn't find the default Subnet for ${firstZone} in this VPC. Weird.`);
console.log('Using Subnet', defaultSubnet.SubnetId);

// Look for an Amazon Linux 2 AMI for arm64
const {Images} = await ec2.describeImages({
  Owners: ['099720109477'],
  Filters: [
    { Name: 'architecture', Values: ['arm64'] },
    { Name: 'state', Values: ['available'] },
    { Name: 'virtualization-type', Values: ['hvm'] },
    { Name: 'name', Values: ['ubuntu/images/hvm-ssd/ubuntu-groovy-20.10-*'] },
  ],
});
// sort newest -> oldest
Images?.sort((a, b) => (b.CreationDate ?? '').localeCompare(a.CreationDate ?? ''));
const amznImage = Images[0];
if (!amznImage?.ImageId) throw new Error(
  `I couldn't find an Amazon2 AMI in this region. Weird.`);
console.log('Using AMI', amznImage.ImageId, '-', amznImage.Name);


// LAUNCH an ec2 instance
const {Instances: [instance]} = await ec2.runInstances({
  InstanceType: "t4g.nano",
  ImageId: amznImage.ImageId,
  NetworkInterfaces: [{
    DeviceIndex: 0,
    AssociatePublicIpAddress: true,
    SubnetId: defaultSubnet.SubnetId,
  }],
  TagSpecifications: [{
    ResourceType: "instance",
    Tags: [
      { Key: "Name", Value: "deno aws_api example" },
      { Key: "DenoExample", Value: ThisScriptUrl },
    ],
  }],
  MinCount: 1,
  MaxCount: 1,
  UserData: btoa(`#!/bin/bash -eux
    curl -s 'https://da.gd/ip?cow'|sed 's/^/-   /'
  `),
});
if (!instance.InstanceId) throw new Error(
  `I couldn't launch an EC2 instance. Weird.`);
console.log('Launched instance:', instance.InstanceId);


// From here we are done accumulating data and can just run through steps
// so below here is just a series of blocks

{ // Wait for 'Ready'
  const {Reservations: [res]} = await ec2.waitForInstanceRunning({
    InstanceIds: [instance.InstanceId],
  });
  console.log('Instance state is now', res?.Instances[0]?.State);
}

{ // Wait ages for console output
  console.log('Waiting for system log to appear... this takes 10 minutes');
  const {Output} = await ec2.waitForConsoleOutputAvailable({
    InstanceId: instance.InstanceId,
  });
  // Look for and print our specific part of cloud-init
  const outputLines = atob(Output ?? '').split('\n');
  const firstRelevantLine = outputLines.findIndex(x => x.includes(`running 'modules:config'`));
  console.log('Console output:');
  for (const line of outputLines.slice(firstRelevantLine)) {
    if (line.includes('cloud-init')) console.log('  |', line);
  }
}

{ // Terminate the instance
  const {TerminatingInstances} = await ec2.terminateInstances({
    InstanceIds: [instance.InstanceId],
  });
  console.log('Terminated:', TerminatingInstances[0]);
}

{ // Wait for 'Terminated'
  const {Reservations: [res]} = await ec2.waitForInstanceTerminated({
    InstanceIds: [instance.InstanceId],
  });
  console.log('Instance state is now', res?.Instances[0]?.State);
}

console.log('All done! Bye');



// Helper function to clean up existing instances

async function performCleanup(activeInstances: Instance[]) {
  const ourInstances = activeInstances.filter(x => x.Tags
    .some(y => y.Key === 'DenoExample' && y.Value === ThisScriptUrl));
  if (ourInstances.length == 0) {
    console.log(`I didn't find any instances to clean up.`);
    return;
  }
  console.log('I found', ourInstances.length, 'instances',
      'laying around that look like I made them!');
  for (const instance of ourInstances) {
    console.log('  -', instance.InstanceId, instance.Tags);
  }
  await new Promise(r => setTimeout(r, 2500));
  console.log('Terminating...');
  const {TerminatingInstances} = await ec2.terminateInstances({
    InstanceIds: ourInstances.map(x => x.InstanceId ?? ''),
  });
  console.log('Terminated:', TerminatingInstances);
}
