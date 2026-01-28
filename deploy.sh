#!/bin/bash

# Deployment script for Weather Agent with Slack Integration
# This script deploys all 3 CDK stacks in the correct order

set -e

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Default configuration
AWS_REGION=${AWS_REGION:-us-east-1}
FOUNDATION_MODEL=${FOUNDATION_MODEL:-us.amazon.nova-pro-v1:0}
SKIP_SLACK=false
AUTO_APPROVE=false
VERBOSE=false

# Function to display help
show_help() {
    cat << EOF
Weather Agent CDK Deployment Script

USAGE:
    deploy.sh [OPTIONS]

DESCRIPTION:
    Deploys the Weather Agent with Slack Integration to AWS using CDK.
    This includes:
      - Image Stack: ECR repository and Docker image build
      - Agent Stack: Agent Core Runtime, Gateway, MCP Lambda, and Memory
      - Slack Stack: API Gateway, Lambda functions, and SQS queues

OPTIONS:
    -h, --help
        Display this help message and exit

    -r, --region REGION
        AWS region for deployment (default: us-east-1)
        Example: --region us-west-2

    -t, --slack-token TOKEN
        Slack bot token (must start with xoxb-)
        Find in: Slack App → OAuth & Permissions → Bot User OAuth Token

    -s, --slack-secret SECRET
        Slack signing secret
        Find in: Slack App → Basic Information → App Credentials

    -S, --skip-slack
        Skip Slack credential prompts and use placeholder values
        Use for testing infrastructure without Slack integration

    -y, --yes
        Auto-approve all prompts (non-interactive mode)
        Useful for CI/CD pipelines

    -m, --model MODEL
        Foundation model ID (default: us.amazon.nova-pro-v1:0)
        Example: --model anthropic.claude-3-sonnet-20240229-v1:0

    -v, --verbose
        Enable verbose output for debugging

CONFIGURATION PRECEDENCE:
    Command-line parameters override environment variables.
    Environment variables override default values.

EXAMPLES:
    # Interactive deployment with Slack credentials
    ./deploy.sh --slack-token xoxb-... --slack-secret ...

    # Deploy to specific region
    ./deploy.sh --region us-west-2

    # Non-interactive deployment for CI/CD
    ./deploy.sh --yes --skip-slack

    # Deploy with environment variables (backward compatible)
    export SLACK_BOT_TOKEN=xoxb-...
    export SLACK_SIGNING_SECRET=...
    ./deploy.sh

PREREQUISITES:
    - AWS CLI configured with credentials
    - Node.js v18+ and npm
    - Slack App created (if using Slack integration)

For more information, see README.md
EOF
}

# Function to parse command-line arguments
parse_arguments() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            -h|--help)
                show_help
                exit 0
                ;;
            -r|--region)
                if [ -z "$2" ] || [[ "$2" == -* ]]; then
                    echo "Error: --region requires a value"
                    echo "Run 'deploy.sh --help' for usage information"
                    exit 1
                fi
                AWS_REGION="$2"
                AWS_REGION_SOURCE="CLI parameter"
                shift 2
                ;;
            -t|--slack-token)
                if [ -z "$2" ] || [[ "$2" == -* ]]; then
                    echo "Error: --slack-token requires a value"
                    echo "Run 'deploy.sh --help' for usage information"
                    exit 1
                fi
                SLACK_BOT_TOKEN="$2"
                SLACK_TOKEN_SOURCE="CLI parameter"
                shift 2
                ;;
            -s|--slack-secret)
                if [ -z "$2" ] || [[ "$2" == -* ]]; then
                    echo "Error: --slack-secret requires a value"
                    echo "Run 'deploy.sh --help' for usage information"
                    exit 1
                fi
                SLACK_SIGNING_SECRET="$2"
                SLACK_SECRET_SOURCE="CLI parameter"
                shift 2
                ;;
            -S|--skip-slack)
                SKIP_SLACK=true
                shift
                ;;
            -y|--yes)
                AUTO_APPROVE=true
                shift
                ;;
            -m|--model)
                if [ -z "$2" ] || [[ "$2" == -* ]]; then
                    echo "Error: --model requires a value"
                    echo "Run 'deploy.sh --help' for usage information"
                    exit 1
                fi
                FOUNDATION_MODEL="$2"
                MODEL_SOURCE="CLI parameter"
                shift 2
                ;;
            -v|--verbose)
                VERBOSE=true
                shift
                ;;
            *)
                echo "Error: Unknown option $1"
                echo "Run 'deploy.sh --help' for usage information"
                exit 1
                ;;
        esac
    done
}

# Function to validate Slack bot token
validate_slack_token() {
    local token=$1
    
    # Check format (must start with xoxb-)
    if [[ ! "$token" =~ ^xoxb- ]]; then
        echo -e "${YELLOW}⚠️  Warning: SLACK_BOT_TOKEN should start with 'xoxb-'${NC}"
        return 1
    fi
    
    # Validate with Slack API
    echo -e "${CYAN}🔍 Validating Slack token with Slack API...${NC}"
    local response=$(curl -s -X POST https://slack.com/api/auth.test \
        -H "Authorization: Bearer $token" \
        --max-time 10)
    
    # Check if token is valid
    if echo "$response" | grep -q '"ok":true'; then
        echo -e "${GREEN}✓ Slack token validated successfully${NC}"
        
        # Extract and display useful information
        local workspace_url=$(echo "$response" | grep -o '"url":"[^"]*"' | cut -d'"' -f4)
        local team_name=$(echo "$response" | grep -o '"team":"[^"]*"' | cut -d'"' -f4)
        local bot_user=$(echo "$response" | grep -o '"user":"[^"]*"' | cut -d'"' -f4)
        local bot_id=$(echo "$response" | grep -o '"bot_id":"[^"]*"' | cut -d'"' -f4)
        
        echo -e "${BLUE}  📍 Workspace: $workspace_url${NC}"
        echo -e "${BLUE}  🏢 Team: $team_name${NC}"
        echo -e "${BLUE}  🤖 Bot User: $bot_user${NC}"
        echo -e "${BLUE}  🆔 Bot ID: $bot_id${NC}"
        
        return 0
    else
        echo -e "${RED}✗ Slack token validation failed${NC}"
        
        # Try to extract error message if present
        local error=$(echo "$response" | grep -o '"error":"[^"]*"' | cut -d'"' -f4)
        if [ -n "$error" ]; then
            echo -e "${RED}  Error: $error${NC}"
        else
            echo -e "${RED}  Response: $response${NC}"
        fi
        
        return 1
    fi
}

# Function to validate AWS credentials
validate_aws_credentials() {
    echo -e "${CYAN}🔍 Validating AWS credentials...${NC}"
    if ! aws sts get-caller-identity &>/dev/null; then
        echo -e "${RED}✗ AWS credentials not configured or invalid${NC}"
        echo "Please configure AWS CLI with valid credentials"
        exit 1
    fi
    echo -e "${GREEN}✓ AWS credentials validated${NC}"
}

# Parse command-line arguments
parse_arguments "$@"

# Set configuration source indicators
if [ -z "$AWS_REGION_SOURCE" ]; then
    if [ -n "${AWS_REGION}" ] && [ "${AWS_REGION}" != "us-east-1" ]; then
        AWS_REGION_SOURCE="environment variable"
    else
        AWS_REGION_SOURCE="default"
    fi
fi

if [ -z "$SLACK_TOKEN_SOURCE" ]; then
    if [ -n "${SLACK_BOT_TOKEN}" ]; then
        SLACK_TOKEN_SOURCE="environment variable"
    fi
fi

if [ -z "$SLACK_SECRET_SOURCE" ]; then
    if [ -n "${SLACK_SIGNING_SECRET}" ]; then
        SLACK_SECRET_SOURCE="environment variable"
    fi
fi

if [ -z "$MODEL_SOURCE" ]; then
    if [ -n "${FOUNDATION_MODEL}" ] && [ "${FOUNDATION_MODEL}" != "us.amazon.nova-pro-v1:0" ]; then
        MODEL_SOURCE="environment variable"
    else
        MODEL_SOURCE="default"
    fi
fi

# Validate AWS credentials first
validate_aws_credentials
echo ""

echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║                                                            ║${NC}"
echo -e "${BLUE}║        🚀 Weather Agent CDK Deployment 🚀                 ║${NC}"
echo -e "${BLUE}║                                                            ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""

echo -e "${CYAN}📋 Deployment Configuration:${NC}"
echo ""

# Get AWS Account ID and Role information (without buffering output)
echo -e "${CYAN}🔍 Retrieving AWS account information...${NC}"
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
AWS_USER_ARN=$(aws sts get-caller-identity --query Arn --output text)

echo -e "${GREEN}  ✓ AWS Account: ${AWS_ACCOUNT_ID}${NC}"
echo -e "${GREEN}  ✓ AWS Role: ${AWS_USER_ARN}${NC}"
echo -e "${GREEN}  ✓ AWS Region: ${AWS_REGION}${NC} ${YELLOW}(${AWS_REGION_SOURCE})${NC}"
echo -e "${GREEN}  ✓ Foundation Model: ${FOUNDATION_MODEL}${NC} ${YELLOW}(${MODEL_SOURCE})${NC}"
echo ""
echo -e "${CYAN}📦 This deployment includes:${NC}"
echo -e "  ${BLUE}•${NC} Amazon Bedrock Agent Core Runtime with Gateway integration"
echo -e "  ${BLUE}•${NC} MCP Lambda server for weather tools"
echo -e "  ${BLUE}•${NC} Slack integration with API Gateway and Lambda functions"
echo -e "  ${BLUE}•${NC} Conversation memory with 90-day retention"
echo ""

# Flush output to ensure user sees the above before validation starts
sync

# Handle Slack credentials
if [ "$SKIP_SLACK" = true ]; then
    echo -e "${YELLOW}⚠️  Skipping Slack credential configuration (--skip-slack flag)${NC}"
    SLACK_BOT_TOKEN="PLACEHOLDER"
    SLACK_SIGNING_SECRET="PLACEHOLDER"
    echo ""
else
    # Check if Slack credentials are provided
    if [ -z "$SLACK_BOT_TOKEN" ] || [ -z "$SLACK_SIGNING_SECRET" ]; then
        if [ "$AUTO_APPROVE" = true ]; then
            echo "⚠️  Auto-approve mode: Using placeholder Slack credentials"
            SLACK_BOT_TOKEN="PLACEHOLDER"
            SLACK_SIGNING_SECRET="PLACEHOLDER"
            echo ""
        else
            echo "⚠️  Slack credentials not found"
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
                SLACK_TOKEN_SOURCE="interactive input"
                SLACK_SECRET_SOURCE="interactive input"
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
                
                if [ "$AUTO_APPROVE" = true ]; then
                    echo "Auto-approve mode: Continuing with placeholder credentials"
                    SLACK_BOT_TOKEN="PLACEHOLDER"
                    SLACK_SIGNING_SECRET="PLACEHOLDER"
                else
                    read -p "Continue anyway? (yes/no): " continue_deploy
                    if [ "$continue_deploy" != "yes" ]; then
                        echo "Deployment cancelled."
                        exit 0
                    fi
                    SLACK_BOT_TOKEN="PLACEHOLDER"
                    SLACK_SIGNING_SECRET="PLACEHOLDER"
                fi
            fi
        fi
    fi
    
    # Validate Slack credentials format and with API if provided
    if [ -n "$SLACK_BOT_TOKEN" ] && [ "$SLACK_BOT_TOKEN" != "PLACEHOLDER" ]; then
        if ! validate_slack_token "$SLACK_BOT_TOKEN"; then
            # If token was provided via CLI parameter, abort immediately
            if [ "$SLACK_TOKEN_SOURCE" = "CLI parameter" ]; then
                echo ""
                echo -e "${RED}✗ Deployment aborted: Invalid Slack token provided via CLI parameter${NC}"
                echo -e "${YELLOW}  Please verify your token and try again${NC}"
                exit 1
            fi
            
            # If token was from environment or interactive, prompt user
            if [ "$AUTO_APPROVE" = true ]; then
                echo "✗ Auto-approve mode: Aborting due to invalid Slack token"
                exit 1
            else
                read -p "Continue anyway? (yes/no): " continue_token
                if [ "$continue_token" != "yes" ]; then
                    exit 1
                fi
            fi
        fi
    fi
fi

echo ""
echo "Slack Credentials Status:"
if [ -n "$SLACK_BOT_TOKEN" ] && [ "$SLACK_BOT_TOKEN" != "PLACEHOLDER" ]; then
    echo "  ✓ Bot Token: ${SLACK_BOT_TOKEN:0:10}... (${SLACK_TOKEN_SOURCE})"
else
    echo "  ✗ Bot Token: Not set (will use placeholder)"
fi

if [ -n "$SLACK_SIGNING_SECRET" ] && [ "$SLACK_SIGNING_SECRET" != "PLACEHOLDER" ]; then
    echo "  ✓ Signing Secret: ${SLACK_SIGNING_SECRET:0:8}... (${SLACK_SECRET_SOURCE})"
else
    echo "  ✗ Signing Secret: Not set (will use placeholder)"
fi
echo ""

# Export for CDK
export SLACK_BOT_TOKEN
export SLACK_SIGNING_SECRET
export AWS_REGION
export FOUNDATION_MODEL

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
    
    # Start CDK deploy in background with --no-rollback for troubleshooting
    cdk deploy "${stack_name}" --require-approval never --no-rollback &
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
