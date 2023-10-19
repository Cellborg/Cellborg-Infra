#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { IacStack } from '../lib/iac-stack';

const app = new cdk.App();
const env = app.node.tryGetContext('environment') || 'beta'; 

new IacStack(app, 'IacStack', {
  stackName: `Cellborg-${env}-stack`,
  env: { account: '865984939637', region: 'us-west-2' },
});
