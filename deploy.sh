#!/bin/bash

# Deployment script for Weather Agent with Slack Integration (v2 CDK)
# This script deploys all 3 CDK stacks in the correct order
# v2 uses Agent Core Gateway for proper tool routing

set -e

# Configuration
AWS_REGION=${AWS_REGION:-us-east-1}
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

echo "=== Weather Agent CDK Deployment (v2) ==="
echo "AWS Account: $AWS_ACCOUNT_ID"
echo "AWS Region: $AWS_REGION"
echo ""
echo "v2 Changes:"
echo "  - Agent Runtime uses Gateway for tool access"
echo "  - Proper MCP protocol routing"
echo "  - Runtime → Gateway → Lambda architecture"
echo "  - All stacks deployed via CDK"
echo ""

# Check if Slack credentials are provided
if [ -z "$SLACK_BOT_TOKEN" ] || [ -z "$SLACK_SIGNING_SECRET" ]; then
    echo "⚠️  Slack credentials not found in environment variables"
    echo ""
    read -p "Do you want to enter Slack credentials now? (yes/no): " enter_creds
    
    if [ "$enter_creds" = "yes" ]; then
        echo ""
        echo "You can find these in your Slack App settings:"
        echo "  - Bot Token: OAuth & Permissions → Bot User OAuth Token (starts with xoxb-)"
        echo "  - Signing Secret: Basic Information → App Credentials → Signing Secret"
        echo ""
        read -p "Enter Slack Bot Token (xoxb-...): " SLACK_BOT_TOKEN
        read -p "Enter Slack Signing Secret: " SLACK_SIGNING_SECRET
        export SLACK_BOT_TOKEN
        export SLACK_SIGNING_SECRET
    else
        echo ""
        echo "⚠️  WARNING: Deploying without Slack credentials!"
        echo "   The Slack integration will NOT work until you update the secret."
        echo ""
        echo "To update later, run:"
        echo "  export SLACK_BOT_TOKEN=xoxb-..."
        echo "  export SLACK_SIGNING_SECRET=..."
        echo "  ./deploy.sh"
        echo ""
        read -p "Continue anyway? (yes/no): " continue_deploy
        if [ "$continue_deploy" != "yes" ]; then
            echo "Deployment cancelled."
            exit 0
        fi
    fi
fi

# Validate Slack credentials format if provided
if [ -n "$SLACK_BOT_TOKEN" ] && [ "$SLACK_BOT_TOKEN" != "PLACEHOLDER" ]; then
    if [[ ! "$SLACK_BOT_TOKEN" =~ ^xoxb- ]]; then
        echo "⚠️  Warning: SLACK_BOT_TOKEN should start with 'xoxb-'"
        read -p "Continue anyway? (yes/no): " continue_token
        if [ "$continue_token" != "yes" ]; then
            exit 1
        fi
    fi
fi

echo ""
echo "Slack Credentials Status:"
if [ -n "$SLACK_BOT_TOKEN" ] && [ "$SLACK_BOT_TOKEN" != "PLACEHOLDER" ]; then
    echo "  ✓ Bot Token: ${SLACK_BOT_TOKEN:0:10}..."
else
    echo "  ✗ Bot Token: Not set (will use placeholder)"
fi

if [ -n "$SLACK_SIGNING_SECRET" ] && [ "$SLACK_SIGNING_SECRET" != "PLACEHOLDER" ]; then
    echo "  ✓ Signing Secret: ${SLACK_SIGNING_SECRET:0:8}..."
else
    echo "  ✗ Signing Secret: Not set (will use placeholder)"
fi
echo ""

# Navigate to CDK directory
cd cdk

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "Installing CDK dependencies..."
    npm install
fi

# Build TypeScript
echo "Building CDK project..."
npm run build

# Bootstrap CDK (if not already done)
echo "Checking CDK bootstrap..."
cdk bootstrap aws://$AWS_ACCOUNT_ID/$AWS_REGION 2>/dev/null || echo "Already bootstrapped"

# Deploy all stacks
echo ""
echo "=== Deploying All Stacks Sequentially ==="

echo ""
echo "Step 1/3: Deploying Image Stack..."
cdk deploy WeatherAgentImageStack --require-approval never

echo ""
echo "Step 2/3: Deploying Agent Core Stack..."
cdk deploy WeatherAgentCoreStack --require-approval never

echo ""
echo "Step 3/3: Deploying Slack Stack..."
cdk deploy WeatherAgentSlackStack --require-approval never

# Get outputs
echo ""
echo "=== Deployment Complete (v2 CDK) ==="
echo ""
echo "Getting stack outputs..."

WEBHOOK_URL=$(aws cloudformation describe-stacks \
    --stack-name WeatherAgentSlackStack \
    --query 'Stacks[0].Outputs[?OutputKey==`WebhookURL`].OutputValue' \
    --output text \
    --region $AWS_REGION 2>/dev/null || echo "Not available yet")

RUNTIME_ARN=$(aws cloudformation describe-stacks \
    --stack-name WeatherAgentCoreStack \
    --query 'Stacks[0].Outputs[?OutputKey==`RuntimeArn`].OutputValue' \
    --output text \
    --region $AWS_REGION 2>/dev/null || echo "Not available yet")

GATEWAY_ARN=$(aws cloudformation describe-stacks \
    --stack-name WeatherAgentCoreStack \
    --query 'Stacks[0].Outputs[?OutputKey==`GatewayArn`].OutputValue' \
    --output text \
    --region $AWS_REGION 2>/dev/null || echo "Not available yet")

echo ""
echo "Stack Information:"
echo "  Image Stack:  WeatherAgentImageStack"
echo "  Agent Stack:  WeatherAgentCoreStack"
echo "  Slack Stack:  WeatherAgentSlackStack"
echo ""
echo "Resources:"
echo "  Runtime ARN:  $RUNTIME_ARN"
echo "  Gateway ARN:  $GATEWAY_ARN"
echo "  Webhook URL:  $WEBHOOK_URL"
echo ""
echo "Architecture (v2):"
echo "  Slack → API Gateway → Lambda → SQS → Lambda → Runtime → Gateway → MCP Lambda"
echo ""

# Check if credentials were actually set
if [ -n "$SLACK_BOT_TOKEN" ] && [ "$SLACK_BOT_TOKEN" != "PLACEHOLDER" ]; then
    echo "✓ Slack credentials configured"
    echo ""
    echo "Next steps:"
    echo "1. Go to your Slack App settings: https://api.slack.com/apps"
    echo "2. Navigate to Event Subscriptions"
    echo "3. Set Request URL to: $WEBHOOK_URL"
    echo "4. Ensure these events are subscribed:"
    echo "   - app_mention"
    echo "   - message.im"
    echo "5. Save changes"
    echo "6. Invite the bot to channels: /invite @YourBotName"
else
    echo "⚠️  Slack credentials NOT configured!"
    echo ""
    echo "To configure Slack integration:"
    echo "1. Get your Slack credentials from https://api.slack.com/apps"
    echo "2. Run: export SLACK_BOT_TOKEN=xoxb-... SLACK_SIGNING_SECRET=..."
    echo "3. Run: ./deploy.sh (to update the secret)"
fi

echo ""
echo "Test the deployment:"
echo "  - Send a DM to the bot: 'What is the weather in Seattle?'"
echo "  - Mention in channel: '@YourBotName What is the weather in Chicago?'"
echo ""
echo "Monitor logs:"
echo "  aws logs tail /aws/lambda/WeatherAgentSlackStack-agent-integration --follow"
echo ""
