# Client Code Generation for AWS APIs

Strictly speaking, this entire folder is implementation detail of the `/x/aws_api` module.

Note that aws-sdk-js v2 is scheduled for end-of-life, and as such, this module might need porting to the Smithy definitions used by the next-gen AWS SDKs.

## Module Layout

* The top level contains logic to produce service clients from the definitions of aws-sdk-js v2.
* `script/` contains the scripts that I use to generate tests and rebuild the pre-generated clients.
* `deploy/` contains a Deno Deploy service to serve generated code, deployed to https://aws-api.deno.dev
