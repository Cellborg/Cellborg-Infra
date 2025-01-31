#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { IacStack } from '../lib/iac-stack';

const app = new cdk.App();
const env = app.node.tryGetContext('environment') || 'beta'; 

new IacStack(app, 'IacStack', {
  stackName: `Cellborg-${env}-stack`,
  env: { account: '536697236385', region: 'us-east-1' },
});
