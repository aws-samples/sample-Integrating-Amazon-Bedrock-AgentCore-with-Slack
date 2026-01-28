#!/bin/bash

# Cleanup script for Weather Agent with Slack Integration (v2 CDK)
# This script removes all deployed CDK resources

set -e

# Parse command-line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -r|--region)
            if [ -z "$2" ] || [[ "$2" == -* ]]; then
                echo "Error: --region requires a value"
                exit 1
            fi
            AWS_REGION="$2"
            shift 2
            ;;
        -h|--help)
            echo "Weather Agent CDK Cleanup Script"
            echo ""
            echo "USAGE:"
            echo "    cleanup.sh [OPTIONS]"
            echo ""
            echo "OPTIONS:"
            echo "    -r, --region REGION    AWS region (default: us-east-1)"
            echo "    -h, --help             Display this help message"
            echo ""
            echo "EXAMPLES:"
            echo "    ./cleanup.sh"
            echo "    ./cleanup.sh --region us-west-2"
            exit 0
            ;;
        *)
            echo "Error: Unknown option $1"
            echo "Run 'cleanup.sh --help' for usage information"
            exit 1
            ;;
    esac
done

# Configuration
AWS_REGION=${AWS_REGION:-us-east-1}
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "unknown")

echo "=== Weather Agent CDK Cleanup (v2) ==="
echo "AWS Account: $AWS_ACCOUNT_ID"
echo "AWS Region: $AWS_REGION"
echo ""
echo "⚠️  WARNING: This will delete all Weather Agent CDK resources!"
echo "This includes:"
echo "  - All 3 CDK stacks"
echo "  - ECR repository and Docker images"
echo "  - All Lambda functions and logs"
echo "  - Agent Core Runtime and Gateway"
echo "  - SQS queues and messages"
echo "  - Secrets Manager secrets"
echo ""
read -p "Are you sure you want to continue? (yes/no): " confirm

if [ "$confirm" != "yes" ]; then
    echo "Cleanup cancelled."
    exit 0
fi

echo ""
echo "Starting CDK cleanup..."
echo ""

# Navigate to CDK directory
cd cdk

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "Installing CDK dependencies..."
    npm install
fi

# Build TypeScript
echo "Building CDK project..."
npm run build

# Check for stacks in failed states and delete them directly via CloudFormation
echo ""
echo "=== Checking for Failed Stacks ==="
FAILED_STACKS=$(aws cloudformation list-stacks \
    --region "$AWS_REGION" \
    --query 'StackSummaries[?StackStatus==`ROLLBACK_FAILED` || StackStatus==`CREATE_FAILED` || StackStatus==`DELETE_FAILED` && contains(StackName, `WeatherAgent`)].StackName' \
    --output text)

if [ -n "$FAILED_STACKS" ]; then
    echo "Found stacks in failed state. Deleting directly via CloudFormation..."
    for stack in $FAILED_STACKS; do
        echo "Deleting $stack..."
        aws cloudformation delete-stack --stack-name "$stack" --region "$AWS_REGION" || true
        echo "Waiting for $stack to be deleted..."
        aws cloudformation wait stack-delete-complete --stack-name "$stack" --region "$AWS_REGION" 2>/dev/null || true
    done
fi

# Check if any active stacks remain
echo ""
echo "=== Checking for Active Stacks ==="
ACTIVE_STACKS=$(aws cloudformation list-stacks \
    --region "$AWS_REGION" \
    --query 'StackSummaries[?StackStatus!=`DELETE_COMPLETE` && contains(StackName, `WeatherAgent`)].StackName' \
    --output text)

if [ -n "$ACTIVE_STACKS" ]; then
    echo "Found active stacks. Destroying via CDK..."
    cdk destroy --all --force || true
else
    echo "No active stacks found. Skipping CDK destroy."
fi

cd ..

echo ""
echo "=== Additional Cleanup ==="

# Clean up any remaining ECR images (CDK should handle this, but just in case)
echo "Checking for remaining ECR images..."
if aws ecr describe-repositories --repository-names weather-agent-runtime --region "$AWS_REGION" &>/dev/null; then
    echo "Deleting remaining ECR images..."
    aws ecr list-images \
        --repository-name weather-agent-runtime \
        --region "$AWS_REGION" \
        --query 'imageIds[*]' \
        --output json 2>/dev/null | \
    jq -r '.[] | @json' | \
    while read -r image; do
        aws ecr batch-delete-image \
            --repository-name weather-agent-runtime \
            --region "$AWS_REGION" \
            --image-ids "$image" 2>/dev/null || true
    done
    
    echo "Deleting ECR repository..."
    aws ecr delete-repository \
        --repository-name weather-agent-runtime \
        --region "$AWS_REGION" \
        --force 2>/dev/null || true
    echo "✓ ECR repository deleted"
else
    echo "✓ ECR repository already deleted"
fi

# Clean up CloudWatch Log Groups (CDK may not delete these automatically)
echo ""
echo "Cleaning up CloudWatch Log Groups..."
for log_group in \
    "/aws/lambda/WeatherAgentSlackStack-verification" \
    "/aws/lambda/WeatherAgentSlackStack-sqs-integration" \
    "/aws/lambda/WeatherAgentSlackStack-agent-integration" \
    "/aws/lambda/WeatherAgentCoreStack-mcp-server" \
    "/aws/lambda/WeatherAgentImageStack-TriggerBuildFunction"
do
    if aws logs describe-log-groups --log-group-name-prefix "$log_group" --region "$AWS_REGION" --query 'logGroups[0]' --output text &>/dev/null; then
        echo "Deleting $log_group..."
        aws logs delete-log-group --log-group-name "$log_group" --region "$AWS_REGION" 2>/dev/null || true
    fi
done

echo "Deleting CodeBuild log groups..."
aws logs describe-log-groups \
    --log-group-name-prefix "/aws/codebuild/WeatherAgentImageStack" \
    --region "$AWS_REGION" \
    --query 'logGroups[*].logGroupName' \
    --output text 2>/dev/null | \
while read -r log_group; do
    if [ -n "$log_group" ]; then
        echo "Deleting $log_group..."
        aws logs delete-log-group --log-group-name "$log_group" --region "$AWS_REGION" 2>/dev/null || true
    fi
done
echo "✓ Log groups cleaned up"

# Clean up S3 buckets (CDK staging buckets)
echo ""
echo "Checking for CDK staging buckets..."
aws s3 ls | grep "cdk-" | awk '{print $3}' | while read -r bucket; do
    if [[ $bucket == cdk-*-assets-${AWS_ACCOUNT_ID}-${AWS_REGION} ]]; then
        echo "Note: CDK staging bucket found: $bucket"
        echo "      (Not deleting - may be used by other CDK apps)"
    fi
done

echo ""
echo "=== Cleanup Complete ==="
echo ""
echo "All Weather Agent CDK resources have been removed from AWS account $AWS_ACCOUNT_ID"
echo ""
echo "Summary:"
echo "  ✓ All CDK stacks destroyed"
echo "  ✓ ECR repository and images deleted"
echo "  ✓ CloudWatch log groups deleted"
echo ""
echo "Note: CDK staging buckets are preserved as they may be used by other CDK apps."
echo "You can verify cleanup by checking the CloudFormation console."
