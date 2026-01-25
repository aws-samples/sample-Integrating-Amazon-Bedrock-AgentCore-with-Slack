#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { WeatherAgentImageStack } from '../lib/image-stack';
import { WeatherAgentCoreStack } from '../lib/agent-stack';
import { WeatherAgentSlackStack } from '../lib/slack-stack';

const app = new cdk.App();

// Get configuration from context or environment
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
};

const slackBotToken = process.env.SLACK_BOT_TOKEN || app.node.tryGetContext('slackBotToken');
const slackSigningSecret = process.env.SLACK_SIGNING_SECRET || app.node.tryGetContext('slackSigningSecret');

if (!slackBotToken || !slackSigningSecret) {
  console.warn('⚠️  SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET not set. Slack stack will use placeholder values.');
  console.warn('   Set them via: export SLACK_BOT_TOKEN=xoxb-... SLACK_SIGNING_SECRET=...');
}

// Stack 1: Build and push Docker image to ECR
const imageStack = new WeatherAgentImageStack(app, 'WeatherAgentImageStack', {
  env,
  description: 'Weather Agent - Docker Image Build',
});

// Stack 2: Agent Core Runtime with Gateway
const agentStack = new WeatherAgentCoreStack(app, 'WeatherAgentCoreStack', {
  env,
  description: 'Weather Agent - Agent Core Runtime with Gateway',
  imageUri: imageStack.imageUri,
});
agentStack.addDependency(imageStack);

// Stack 3: Slack Integration
const slackStack = new WeatherAgentSlackStack(app, 'WeatherAgentSlackStack', {
  env,
  description: 'Weather Agent - Slack Integration',
  agentRuntimeArn: agentStack.runtimeArn,
  memoryId: agentStack.memoryId,
  slackBotToken: slackBotToken || 'PLACEHOLDER',
  slackSigningSecret: slackSigningSecret || 'PLACEHOLDER',
});
slackStack.addDependency(agentStack);

// Add tags to all stacks
cdk.Tags.of(app).add('Project', 'WeatherAgent');
cdk.Tags.of(app).add('Architecture', 'Gateway-Based');

app.synth();
