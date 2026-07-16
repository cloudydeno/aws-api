#!/bin/sh -eux

deno run \
  --allow-read=. \
  --allow-write=. \
  --allow-net=raw.githubusercontent.com,api.github.com \
  --allow-run=deno \
  codegen/script/update-services.ts \
  monitoring,dynamodb,ecr,kinesis,kms,lambda,route53,s3,sesv2,sns,sqs,sts

deno run \
  --allow-read=. \
  --allow-write=lib \
  codegen/script/update-readme.ts
