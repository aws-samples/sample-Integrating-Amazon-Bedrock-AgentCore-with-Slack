# Project Structure

Weather Agent with Slack Integration using Amazon Bedrock Agent Core and AWS CDK.

## Directory Layout

```
.
├── cdk/                          # CDK Infrastructure Code
│   ├── bin/
│   │   └── app.ts               # CDK app entry point (3 stacks)
│   ├── lib/
│   │   ├── image-stack.ts       # Stack 1: ECR + CodeBuild
│   │   ├── agent-stack.ts       # Stack 2: Runtime + Gateway + Memory
│   │   └── slack-stack.ts       # Stack 3: Slack integration
│   ├── .gitignore              # Git ignore for CDK
│   ├── cdk.json                # CDK configuration
│   ├── package.json            # NPM dependencies
│   └── tsconfig.json           # TypeScript configuration
│
├── agentcore/                   # Agent Runtime Code
│   ├── agent_runtime.py        # Agent runtime with Memory integration
│   ├── streamable_http_sigv4.py # SigV4 HTTP client for Gateway
│   ├── Dockerfile              # Container image for runtime
│   └── requirements.txt        # Python dependencies
│
├── .gitignore                   # Git ignore rules
├── DEPLOYMENT-GUIDE.md          # Detailed deployment instructions
├── LICENSE                      # Apache 2.0 License
├── README.md                    # Quick start guide
├── STRUCTURE.md                 # This file
├── cleanup.sh                   # Cleanup script
└── deploy.sh                    # Deployment script
```

## Key Files

### Infrastructure (CDK)

**`cdk/bin/app.ts`**
- CDK application entry point
- Defines all 3 stacks with dependencies
- Reads Slack credentials from environment variables

**`cdk/lib/image-stack.ts`**
- Creates ECR repository for container images
- Sets up CodeBuild project for ARM64 (Graviton) builds
- Uploads agentcore/ folder to S3
- Builds and pushes Docker image
- Implements security features: SSL enforcement, KMS encryption, S3 access logging

**`cdk/lib/agent-stack.ts`**
- Creates Agent Core Runtime with custom Docker image
- Sets up Gateway with MCP Lambda target
- Configures Memory resource with 90-day retention
- Defines 5 weather tools in Gateway schema
- Grants IAM permissions for Runtime to access Gateway and Memory

**`cdk/lib/slack-stack.ts`**
- Creates API Gateway for Slack webhooks
- Sets up 3 Lambda functions (verification, SQS integration, agent integration)
- Creates SQS FIFO queues for async processing
- Stores Slack credentials in Secrets Manager
- Implements HMAC-SHA256 signature verification
- Implements security features: SSL enforcement, API Gateway logging, request validation

### Runtime Code

**`agentcore/agent_runtime.py`**
- Python agent using Strands SDK
- Invokes tools through Gateway using SigV4 authentication
- Loads conversation history from Memory before each invocation
- Stores messages in Memory after each turn for context continuity
- Handles agent logic and responses

**`agentcore/streamable_http_sigv4.py`**
- Custom HTTP client for MCP protocol
- Implements AWS SigV4 request signing
- Supports streaming responses
- Handles Gateway authentication

**`agentcore/Dockerfile`**
- Multi-stage build for Python runtime
- Installs dependencies
- Copies agent code
- Configures entry point

**`agentcore/requirements.txt`**
- Python dependencies:
  - bedrock-agentcore-runtime (Agent Core SDK)
  - strands (Agent framework)
  - boto3 (AWS SDK)

### Scripts

**`deploy.sh`**
- Installs CDK dependencies
- Builds TypeScript
- Bootstraps CDK if needed
- Deploys all 3 stacks in order
- Displays outputs including webhook URL

**`cleanup.sh`**
- Prompts for confirmation
- Handles failed stacks gracefully
- Destroys all CDK stacks
- Cleans up ECR images
- Removes CloudWatch log groups

### Documentation

**`README.md`**
- Quick start guide
- Architecture overview
- Prerequisites
- Basic usage instructions

**`DEPLOYMENT-GUIDE.md`**
- Detailed step-by-step deployment instructions
- Slack app configuration
- Testing procedures
- Troubleshooting guide

**`STRUCTURE.md`**
- This file
- Project structure explanation
- File descriptions

**`LICENSE`**
- Apache 2.0 License

## Build Artifacts (Gitignored)

These are auto-generated and excluded from version control:

- `cdk/node_modules/` - NPM dependencies
- `cdk/dist/` - Compiled JavaScript
- `cdk/cdk.out/` - CDK synthesis output
- `.venv/` - Python virtual environment

## Usage

### Deploy
```bash
export SLACK_BOT_TOKEN="xoxb-..."
export SLACK_SIGNING_SECRET="..."
./deploy.sh
```

### Cleanup
```bash
./cleanup.sh
```

### Modify Infrastructure
Edit files in `cdk/lib/`, then:
```bash
cd cdk
npm run build
cdk diff    # Preview changes
cdk deploy  # Apply changes
```

### Modify Runtime
Edit `agentcore/agent_runtime.py`, then redeploy:
```bash
./deploy.sh  # Will rebuild Docker image
```

## Dependencies

### CDK Dependencies (package.json)
- `aws-cdk`: ^2.235.0
- `aws-cdk-lib`: ^2.235.0
- `@aws-cdk/aws-bedrock-agentcore-alpha`: ^2.235.1-alpha.0
- `constructs`: ^10.3.0
- `typescript`: ^5.3.3

### Python Dependencies (requirements.txt)
- `bedrock-agentcore-runtime>=0.1.0`
- `strands>=0.1.0`
- `boto3>=1.34.0`

## Architecture Flow

1. **User sends message in Slack** (direct message or @mention in channel)
2. **Slack → API Gateway** (webhook POST to `/slack-events`)
3. **API Gateway → Verification Lambda** (validates HMAC-SHA256 signature)
4. **Verification Lambda → SQS Integration Lambda** (async invocation)
5. **SQS Integration Lambda → SQS FIFO Queue** (queues message with session ID)
6. **SQS → Agent Integration Lambda** (processes message)
7. **Agent Integration Lambda → Agent Runtime** (invokes with session ID)
8. **Agent Runtime → Memory** (loads last 5 conversation turns)
9. **Agent Runtime → Gateway** (requests tool execution)
10. **Gateway → MCP Lambda** (executes weather tool)
11. **MCP Lambda → Gateway** (returns result)
12. **Gateway → Agent Runtime** (delivers result)
13. **Agent Runtime → Memory** (stores conversation turn)
14. **Agent Runtime → Agent Integration Lambda** (returns response)
15. **Agent Integration Lambda → Slack API** (posts message in thread)

## Security Features

- **Encryption at Rest**: KMS encryption for CodeBuild with automatic key rotation
- **Encryption in Transit**: SSL/TLS enforced on all S3 buckets and SQS queues
- **Logging**: S3 access logs, API Gateway access logs, CloudWatch logs
- **Authentication**: HMAC-SHA256 signature verification for Slack webhooks
- **Authorization**: IAM roles with least-privilege policies
- **Secret Management**: Secrets Manager for Slack credentials
- **Request Validation**: API Gateway request validator
- **Gateway Authentication**: SigV4 signing for Agent Core Gateway access

## Technical Details

- **Foundation Model**: us.amazon.nova-pro-v1:0
- **Runtime**: Python 3.13
- **Lambda Runtime**: Node.js 20.x (Slack integration)
- **Architecture**: ARM64 (AWS Graviton)
- **Memory Retention**: 90 days
- **Tools**: 5 weather tools (coordinates, current weather, forecast, historical, time)
- **Session Management**: Derived from Slack thread timestamps
- **Queue Type**: SQS FIFO for ordered processing
