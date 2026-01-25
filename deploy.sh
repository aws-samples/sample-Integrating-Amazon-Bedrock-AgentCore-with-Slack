#!/bin/bash

# Deployment script for Weather Agent with Slack Integration
# This script deploys all 3 CDK stacks in the correct order

set -e

# Configuration
AWS_REGION=${AWS_REGION:-us-east-1}
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

echo "=== Weather Agent CDK Deployment ==="
echo "AWS Account: ${AWS_ACCOUNT_ID}"
echo "AWS Region: ${AWS_REGION}"
echo ""
echo "This deployment includes:"
echo "  - Amazon Bedrock Agent Core Runtime with Gateway integration"
echo "  - MCP Lambda server for weather tools"
echo "  - Slack integration with API Gateway and Lambda functions"
echo "  - Conversation memory with 90-day retention"
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
cdk bootstrap "aws://${AWS_ACCOUNT_ID}/${AWS_REGION}" 2>/dev/null || echo "Already bootstrapped"

# Function to deploy a stack with timeout and verification
deploy_stack_with_timeout() {
    local stack_name=$1
    local step_num=$2
    local timeout=1800  # 30 minutes timeout
    
    echo ""
    echo "Step ${step_num}/3: Deploying ${stack_name}..."
    
    # Start CDK deploy in background
    cdk deploy "${stack_name}" --require-approval never &
    local cdk_pid=$!
    
    # Monitor the deployment with timeout
    local elapsed=0
    local check_interval=10
    
    while kill -0 $cdk_pid 2>/dev/null; do
        sleep $check_interval
        elapsed=$((elapsed + check_interval))
        
        # Check actual CloudFormation stack status
        local stack_status=$(aws cloudformation describe-stacks \
            --stack-name "${stack_name}" \
            --query 'Stacks[0].StackStatus' \
            --output text 2>/dev/null || echo "NOT_FOUND")
        
        # If stack is complete but CDK is still running, kill CDK and continue
        if [[ "$stack_status" == "CREATE_COMPLETE" ]] || [[ "$stack_status" == "UPDATE_COMPLETE" ]]; then
            echo "✓ Stack ${stack_name} completed successfully (detected via CloudFormation)"
            kill $cdk_pid 2>/dev/null
            wait $cdk_pid 2>/dev/null
            return 0
        fi
        
        # Check for failed states
        if [[ "$stack_status" == *"FAILED"* ]] || [[ "$stack_status" == "ROLLBACK_COMPLETE" ]]; then
            echo "✗ Stack ${stack_name} failed with status: ${stack_status}"
            kill $cdk_pid 2>/dev/null
            wait $cdk_pid 2>/dev/null
            return 1
        fi
        
        # Timeout check
        if [ $elapsed -ge $timeout ]; then
            echo "⚠️  CDK deployment timeout after ${timeout}s, checking CloudFormation status..."
            kill $cdk_pid 2>/dev/null
            wait $cdk_pid 2>/dev/null
            
            # Final status check
            stack_status=$(aws cloudformation describe-stacks \
                --stack-name "${stack_name}" \
                --query 'Stacks[0].StackStatus' \
                --output text 2>/dev/null || echo "NOT_FOUND")
            
            if [[ "$stack_status" == "CREATE_COMPLETE" ]] || [[ "$stack_status" == "UPDATE_COMPLETE" ]]; then
                echo "✓ Stack ${stack_name} is complete (verified via CloudFormation)"
                return 0
            else
                echo "✗ Stack ${stack_name} status: ${stack_status}"
                return 1
            fi
        fi
    done
    
    # CDK process finished normally
    wait $cdk_pid
    local exit_code=$?
    
    if [ $exit_code -eq 0 ]; then
        echo "✓ Stack ${stack_name} deployed successfully"
        return 0
    else
        # Verify actual stack status even if CDK failed
        local stack_status=$(aws cloudformation describe-stacks \
            --stack-name "${stack_name}" \
            --query 'Stacks[0].StackStatus' \
            --output text 2>/dev/null || echo "NOT_FOUND")
        
        if [[ "$stack_status" == "CREATE_COMPLETE" ]] || [[ "$stack_status" == "UPDATE_COMPLETE" ]]; then
            echo "✓ Stack ${stack_name} is complete (CDK reported error but stack succeeded)"
            return 0
        else
            echo "✗ Stack ${stack_name} deployment failed"
            return 1
        fi
    fi
}

# Deploy all stacks
echo ""
echo "=== Deploying All Stacks Sequentially ==="

# Deploy Image Stack
if ! deploy_stack_with_timeout "WeatherAgentImageStack" "1"; then
    echo "Failed to deploy Image Stack. Exiting."
    exit 1
fi

# Deploy Agent Core Stack
if ! deploy_stack_with_timeout "WeatherAgentCoreStack" "2"; then
    echo "Failed to deploy Agent Core Stack. Exiting."
    exit 1
fi

# Deploy Slack Stack
if ! deploy_stack_with_timeout "WeatherAgentSlackStack" "3"; then
    echo "Failed to deploy Slack Stack. Exiting."
    exit 1
fi

# Get outputs
echo ""
echo "=== Deployment Complete ==="
echo ""
echo "Getting stack outputs..."

WEBHOOK_URL=$(aws cloudformation describe-stacks \
    --stack-name WeatherAgentSlackStack \
    --query 'Stacks[0].Outputs[?OutputKey==`WebhookURL`].OutputValue' \
    --output text \
    --region "${AWS_REGION}" 2>/dev/null || echo "Not available yet")

RUNTIME_ARN=$(aws cloudformation describe-stacks \
    --stack-name WeatherAgentCoreStack \
    --query 'Stacks[0].Outputs[?OutputKey==`RuntimeArn`].OutputValue' \
    --output text \
    --region "${AWS_REGION}" 2>/dev/null || echo "Not available yet")

GATEWAY_ARN=$(aws cloudformation describe-stacks \
    --stack-name WeatherAgentCoreStack \
    --query 'Stacks[0].Outputs[?OutputKey==`GatewayArn`].OutputValue' \
    --output text \
    --region "${AWS_REGION}" 2>/dev/null || echo "Not available yet")

echo ""
echo "Stack Information:"
echo "  Image Stack:  WeatherAgentImageStack"
echo "  Agent Stack:  WeatherAgentCoreStack"
echo "  Slack Stack:  WeatherAgentSlackStack"
echo ""
echo "Resources:"
echo "  Runtime ARN:  ${RUNTIME_ARN}"
echo "  Gateway ARN:  ${GATEWAY_ARN}"
echo "  Webhook URL:  ${WEBHOOK_URL}"
echo ""
echo "Architecture:"
echo "  Slack → API Gateway → Lambda → SQS → Lambda → Runtime → Gateway → MCP Lambda"
echo ""

# Check if credentials were actually set
if [ -n "$SLACK_BOT_TOKEN" ] && [ "$SLACK_BOT_TOKEN" != "PLACEHOLDER" ]; then
    echo "✓ Slack credentials configured"
    echo ""
    echo "Next steps:"
    echo "1. Go to your Slack App settings: https://api.slack.com/apps"
    echo "2. Navigate to Event Subscriptions"
    echo "3. Set Request URL to: ${WEBHOOK_URL}"
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
