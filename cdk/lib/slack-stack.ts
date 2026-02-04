import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import { Construct } from 'constructs';

export interface WeatherAgentSlackStackProps extends cdk.StackProps {
  agentRuntimeArn: string;
  memoryId: string;
  slackBotToken: string;
  slackSigningSecret: string;
}

export class WeatherAgentSlackStack extends cdk.Stack {
  public readonly webhookUrl: string;

  constructor(scope: Construct, id: string, props: WeatherAgentSlackStackProps) {
    super(scope, id, props);

    // Dead Letter Queue
    const dlq = new sqs.Queue(this, 'DLQ', {
      queueName: 'AgentCoreProcessingDLQ.fifo',
      fifo: true,
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
    });

    // Processing Queue
    const processingQueue = new sqs.Queue(this, 'ProcessingQueue', {
      queueName: 'AgentCoreProcessingQueue.fifo',
      fifo: true,
      deduplicationScope: sqs.DeduplicationScope.MESSAGE_GROUP,
      fifoThroughputLimit: sqs.FifoThroughputLimit.PER_MESSAGE_GROUP_ID,
      visibilityTimeout: cdk.Duration.seconds(300),
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
      deadLetterQueue: {
        queue: dlq,
        maxReceiveCount: 3,
      },
    });

    // Slack credentials in Secrets Manager
    const slackSecret = new secretsmanager.Secret(this, 'SlackSecret', {
      secretObjectValue: {
        token: cdk.SecretValue.unsafePlainText(props.slackBotToken),
        signingSecret: cdk.SecretValue.unsafePlainText(props.slackSigningSecret),
      },
    });

    // SQS Integration Lambda
    const sqsIntegrationFunction = new lambda.Function(this, 'SQSIntegration', {
      functionName: `${this.stackName}-sqs-integration`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const https = require('https');
const sqs = new SQSClient();

const LOG_LEVEL = process.env.LOG_LEVEL || 'INFO';
const logDebug = (msg) => { if (LOG_LEVEL === 'DEBUG') console.log('[DEBUG]', msg); };
const logInfo = (msg) => { if (['DEBUG', 'INFO'].includes(LOG_LEVEL)) console.log('[INFO]', msg); };
const logError = (msg) => console.error('[ERROR]', msg);

async function callSlack(url, token, data) {
    return new Promise((resolve, reject) => {
        const req = https.request(url, {method: 'POST', headers: {'Authorization': \`Bearer \${token}\`, 'Content-Type': 'application/json'}}, (res) => {
            let d = '';
            res.on('data', (c) => d += c);
            res.on('end', () => {try {resolve(JSON.parse(d));} catch {resolve(d);}});
        });
        req.on('error', reject);
        req.write(JSON.stringify(data));
        req.end();
    });
}

exports.handler = async (event) => {
    logDebug(\`SQS Integration Lambda received event: \${JSON.stringify(event)}\`);
    try {
        const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
        logDebug(\`Parsed body: \${JSON.stringify(body)}\`);
        if (body.type === 'event_callback' && body.event) {
            const e = body.event;
            logDebug(\`Event type: \${e.type}, Channel type: \${e.channel_type}, Bot ID: \${e.bot_id}, Subtype: \${e.subtype}\`);
            
            // Ignore bot messages and message changes to prevent loops
            if (e.bot_id || e.subtype === 'bot_message' || e.subtype === 'message_changed') {
                logInfo('Ignoring bot message or message change to prevent loop');
                return {statusCode: 200, body: JSON.stringify({message: 'Bot message ignored'})};
            }
            
            if (e.type === 'app_mention' || (e.type === 'message' && e.channel_type === 'im')) {
                logInfo('Processing event, posting processing message to Slack');
                logDebug(\`Event details - type: \${e.type}, channel_type: \${e.channel_type}, thread_ts: \${e.thread_ts}, ts: \${e.ts}, user: \${e.user}\`);
                
                // Double-check this is not a bot message by checking if user exists
                if (!e.user) {
                    logInfo('No user field - likely a bot message, ignoring');
                    return {statusCode: 200, body: JSON.stringify({message: 'No user, ignored'})};
                }
                
                // Post "Processing..." message to Slack
                const slackResponse = await callSlack('https://slack.com/api/chat.postMessage', event.slackBotToken, {
                    channel: e.channel,
                    text: '🤔 Processing your request…',
                    thread_ts: e.thread_ts || e.ts
                });
                
                // Validate Slack API response before proceeding
                if (!slackResponse.ok) {
                    logError(\`Slack API call failed: \${slackResponse.error || 'Unknown error'}\`);
                    logDebug(\`Full Slack error response: \${JSON.stringify(slackResponse)}\`);
                    return {statusCode: 500, body: JSON.stringify({error: 'Failed to post processing message to Slack'})};
                }
                
                if (!slackResponse.ts) {
                    logError('Slack API response missing timestamp (ts)');
                    logDebug(\`Full Slack response: \${JSON.stringify(slackResponse)}\`);
                    return {statusCode: 500, body: JSON.stringify({error: 'Invalid Slack API response'})};
                }
                
                logInfo(\`Processing message posted, ts: \${slackResponse.ts}\`);
                logDebug(\`Full Slack response: \${JSON.stringify(slackResponse)}\`);
                
                // Send to SQS with processing message timestamp
                await sqs.send(new SendMessageCommand({
                    QueueUrl: process.env.PROCESSING_QUEUE_URL,
                    MessageBody: JSON.stringify({
                        slackEvent: e, 
                        slackBotToken: event.slackBotToken, 
                        processingMessageTs: slackResponse.ts,
                        threadTs: e.thread_ts || e.ts,  // Store the thread_ts we used
                        timestamp: new Date().toISOString()
                    }),
                    MessageGroupId: e.channel,
                    MessageDeduplicationId: \`\${e.ts}-\${Date.now()}\`
                }));
                logInfo('Message sent to SQS successfully');
            } else {
                logDebug('Event filtered out - not app_mention or message.im');
            }
        } else {
            logDebug('Not an event_callback or missing event');
        }
        return {statusCode: 200, body: JSON.stringify({message: 'OK'})};
    } catch (error) {
        logError(\`Error in SQS integration: \${error.message}\`);
        return {statusCode: 500, body: JSON.stringify({error: error.message})};
    }
};
      `),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        PROCESSING_QUEUE_URL: processingQueue.queueUrl,
        LOG_LEVEL: 'INFO', // Set to 'DEBUG' for verbose logging, 'INFO' for production
      },
    });

    processingQueue.grantSendMessages(sqsIntegrationFunction);

    // Message Verification Lambda
    const verificationFunction = new lambda.Function(this, 'Verification', {
      functionName: `${this.stackName}-verification`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const crypto = require('crypto');
const sm = new SecretsManagerClient();
const lambda = new LambdaClient();

const LOG_LEVEL = process.env.LOG_LEVEL || 'INFO';
const logDebug = (msg) => { if (LOG_LEVEL === 'DEBUG') console.log('[DEBUG]', msg); };
const logInfo = (msg) => { if (['DEBUG', 'INFO'].includes(LOG_LEVEL)) console.log('[INFO]', msg); };
const logError = (msg) => console.error('[ERROR]', msg);

async function verify(body, ts, sig, secret) {
    const base = \`v0:\${ts}:\${body}\`;
    const calc = \`v0=\${crypto.createHmac('sha256', secret).update(base).digest('hex')}\`;
    logDebug(\`Verification details: bodyLength=\${body.length}, timestamp=\${ts}, match=\${sig === calc}\`);
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(calc));
}
exports.handler = async (event) => {
    logDebug(\`Verification Lambda received event: \${JSON.stringify(event)}\`);
    try {
        const h = event.headers || {};
        const body = event.body;
        const parsed = typeof body === 'string' ? JSON.parse(body) : body;
        logDebug(\`Parsed body: \${JSON.stringify(parsed)}\`);
        if (parsed.type === 'url_verification') {
            logInfo('URL verification request');
            return {statusCode: 200, headers: {'Content-Type': 'application/json'}, body: JSON.stringify({challenge: parsed.challenge})};
        }
        const sig = h['X-Slack-Signature'] || h['x-slack-signature'];
        const ts = h['X-Slack-Request-Timestamp'] || h['x-slack-request-timestamp'];
        logDebug(\`Signature check - sig present: \${!!sig}, ts: \${ts}\`);
        if (!sig || !ts || Math.abs(Math.floor(Date.now() / 1000) - parseInt(ts, 10)) > 300) {
            logInfo('Invalid request - missing sig/ts or timestamp too old');
            throw new Error('Invalid request');
        }
        const secret = JSON.parse((await sm.send(new GetSecretValueCommand({SecretId: process.env.SLACK_BOT_TOKEN_SECRET}))).SecretString);
        logInfo('Retrieved secret from Secrets Manager');
        // API Gateway doesn't provide rawBody, use body directly (it's the raw string)
        const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
        if (!await verify(rawBody, ts, sig, secret.signingSecret)) {
            logInfo('Signature verification failed');
            throw new Error('Invalid signature');
        }
        logInfo('Signature verified, invoking SQS integration Lambda');
        await lambda.send(new InvokeCommand({
            FunctionName: process.env.SQS_INTEGRATION_FUNCTION,
            InvocationType: 'Event',
            Payload: JSON.stringify({...event, slackBotToken: secret.token})
        }));
        logInfo('SQS integration Lambda invoked successfully');
        return {statusCode: 200, body: JSON.stringify({message: 'OK'})};
    } catch (error) {
        logError(\`Error in verification Lambda: \${error.message}\`);
        return {statusCode: error.message.includes('signature') ? 403 : 500, body: JSON.stringify({error: error.message})};
    }
};
      `),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        SLACK_BOT_TOKEN_SECRET: slackSecret.secretArn,
        SQS_INTEGRATION_FUNCTION: sqsIntegrationFunction.functionName,
        LOG_LEVEL: 'INFO', // Set to 'DEBUG' for verbose logging, 'INFO' for production
      },
    });

    slackSecret.grantRead(verificationFunction);
    sqsIntegrationFunction.grantInvoke(verificationFunction);

    // Agent Core Integration Lambda
    const agentIntegrationFunction = new lambda.Function(this, 'AgentIntegration', {
      functionName: `${this.stackName}-agent-integration`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
const { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } = require('@aws-sdk/client-bedrock-agentcore');
const https = require('https');
const client = new BedrockAgentCoreClient();

const LOG_LEVEL = process.env.LOG_LEVEL || 'INFO';
const logDebug = (msg) => { if (LOG_LEVEL === 'DEBUG') console.log('[DEBUG]', msg); };
const logInfo = (msg) => { if (['DEBUG', 'INFO'].includes(LOG_LEVEL)) console.log('[INFO]', msg); };
const logError = (msg) => console.error('[ERROR]', msg);

async function callSlack(url, token, data) {
    return new Promise((resolve, reject) => {
        const req = https.request(url, {method: 'POST', headers: {'Authorization': \`Bearer \${token}\`, 'Content-Type': 'application/json'}}, (res) => {
            let d = '';
            res.on('data', (c) => d += c);
            res.on('end', () => {try {resolve(JSON.parse(d));} catch {resolve(d);}});
        });
        req.on('error', reject);
        req.write(JSON.stringify(data));
        req.end();
    });
}

async function invokeAgentCore(runtimeArn, prompt, sessionId, memoryId) {
    try {
        logInfo(\`Invoking Agent Core Runtime for session: \${sessionId}\`);
        logDebug(\`Runtime ARN: \${runtimeArn}, Memory ID: \${memoryId}\`);
        const payload = JSON.stringify({
            prompt: prompt,
            sessionId: sessionId,
            userId: sessionId  // Use sessionId as userId for now
        });
        const cmd = new InvokeAgentRuntimeCommand({
            agentRuntimeArn: runtimeArn,
            runtimeSessionId: sessionId,
            memoryId: memoryId,
            payload: Buffer.from(payload)
        });
        const response = await client.send(cmd);
        logDebug(\`Response received, content type: \${response.contentType}\`);
        let completion = '';
        if (response.contentType && response.contentType.includes('text/event-stream')) {
            const decoder = new TextDecoder();
            for await (const chunk of response.response) {
                const text = decoder.decode(chunk);
                logDebug(\`Stream chunk: \${text}\`);
                if (text.startsWith('data: ')) {
                    const data = text.substring(6).trim();
                    if (data) completion += data;
                }
            }
        } else if (response.contentType === 'application/json') {
            const chunks = [];
            for await (const chunk of response.response) {
                chunks.push(chunk);
            }
            const responseData = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
            logDebug(\`JSON response: \${JSON.stringify(responseData)}\`);
            if (responseData.message && responseData.message.content) {
                const textParts = responseData.message.content.filter(item => item.text).map(item => item.text);
                completion = textParts.join('\\n');
            } else {
                completion = responseData.message || JSON.stringify(responseData);
            }
        } else {
            const chunks = [];
            for await (const chunk of response.response) {
                chunks.push(chunk);
            }
            completion = Buffer.concat(chunks).toString('utf-8');
        }
        logDebug(\`Agent response: \${completion}\`);
        
        // Strip thinking tags and response tags from completion
        completion = completion
            .replace(/<thinking>[\\s\\S]*?<\\/thinking>/gi, '')  // Remove <thinking>...</thinking>
            .replace(/<response>([\\s\\S]*?)<\\/response>/gi, '$1')  // Extract content from <response>...</response>
            .trim();
        
        return {completion: completion || "I received your message but got an empty response.", sessionId};
    } catch (error) {
        logError(\`Error invoking Agent Core: \${error.message}\`);
        logDebug(\`Error details: \${JSON.stringify(error, null, 2)}\`);
        return {completion: "I'm experiencing technical difficulties. Please try again later.", sessionId};
    }
}

exports.handler = async (event) => {
    try {
        for (const record of event.Records) {
            const {slackEvent, slackBotToken, processingMessageTs, threadTs} = JSON.parse(record.body);
            // Use thread_ts for session ID if message is in a thread
            // For initial messages, use the message timestamp (ts) as the thread identifier
            // This ensures all messages in the same thread share the same session ID
            // Replace dots with underscores to comply with Agent Core Memory regex pattern
            const threadIdentifier = slackEvent.thread_ts || slackEvent.ts;
            const rawSessionId = \`slack-thread-\${threadIdentifier}\`;
            const sessionId = rawSessionId.replace(/\\./g, '_').padEnd(33, '0');
            logDebug(\`Session ID: \${sessionId}, Length: \${sessionId.length}, Thread TS: \${slackEvent.thread_ts}, Message TS: \${slackEvent.ts}\`);
            const userMessage = (slackEvent.text || '').replace(/<@[A-Z0-9]+>/g, '').trim();
            if (!userMessage) {
                logInfo('Empty message, skipping');
                continue;
            }
            logDebug(\`Processing message: \${userMessage}\`);
            const response = await invokeAgentCore(process.env.AGENT_CORE_RUNTIME_ARN, userMessage, sessionId, process.env.MEMORY_ID);
            
            // Update the processing message with the final answer
            logInfo(\`Updating processing message ts: \${processingMessageTs}\`);
            logDebug(\`Original thread_ts: \${slackEvent.thread_ts}, Original ts: \${slackEvent.ts}\`);
            
            // IMPORTANT: For chat.update in a thread, we must NOT include thread_ts
            // The ts parameter alone identifies which message to update
            const updateResponse = await callSlack('https://slack.com/api/chat.update', slackBotToken, {
                channel: slackEvent.channel,
                ts: processingMessageTs,
                text: response.completion
            });
            logDebug(\`Update response - ok: \${updateResponse.ok}, error: \${updateResponse.error}\`);
            
            if (!updateResponse.ok) {
                logError(\`Failed to update message: \${JSON.stringify(updateResponse)}\`);
            }
        }
        return {statusCode: 200};
    } catch (error) {
        logError(\`Error: \${error.message}\`);
        throw error;
    }
};
      `),
      timeout: cdk.Duration.seconds(300),
      memorySize: 512,
      environment: {
        AGENT_CORE_RUNTIME_ARN: props.agentRuntimeArn,
        MEMORY_ID: props.memoryId,
        LOG_LEVEL: 'INFO', // Set to 'DEBUG' for verbose logging, 'INFO' for production
      },
    });

    agentIntegrationFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock-agentcore:InvokeAgentRuntime'],
        resources: [
          props.agentRuntimeArn,
          `${props.agentRuntimeArn}/runtime-endpoint/*`
        ],
      })
    );

    // Add SQS event source to agent integration Lambda
    agentIntegrationFunction.addEventSource(
      new lambdaEventSources.SqsEventSource(processingQueue, {
        batchSize: 1,
      })
    );

    // API Gateway CloudWatch role (required for logging)
    // Uses AWS managed policy AmazonAPIGatewayPushToCloudWatchLogs which is the
    // recommended approach per AWS documentation for enabling API Gateway logging.
    // This is a security best practice to enable audit logging.
    const apiGatewayCloudWatchRole = new iam.Role(this, 'ApiGatewayCloudWatchRole', {
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonAPIGatewayPushToCloudWatchLogs'),
      ],
    });

    // Set the CloudWatch role for API Gateway account settings
    new apigateway.CfnAccount(this, 'ApiGatewayAccount', {
      cloudWatchRoleArn: apiGatewayCloudWatchRole.roleArn,
    });

    // API Gateway with logging
    const logGroup = new logs.LogGroup(this, 'ApiGatewayAccessLogs', {
      logGroupName: `/aws/apigateway/${this.stackName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const api = new apigateway.RestApi(this, 'API', {
      restApiName: `${this.stackName}-api`,
      deployOptions: {
        stageName: 'prod',
        accessLogDestination: new apigateway.LogGroupLogDestination(logGroup),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields({
          caller: true,
          httpMethod: true,
          ip: true,
          protocol: true,
          requestTime: true,
          resourcePath: true,
          responseLength: true,
          status: true,
          user: true,
        }),
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: true,
        metricsEnabled: true,
      },
    });

    // Request validator for API Gateway
    const requestValidator = new apigateway.RequestValidator(this, 'RequestValidator', {
      restApi: api,
      requestValidatorName: 'SlackEventValidator',
      validateRequestBody: true,
      validateRequestParameters: true,
    });

    const slackEvents = api.root.addResource('slack-events');
    const postMethod = slackEvents.addMethod(
      'POST',
      new apigateway.LambdaIntegration(verificationFunction),
      {
        requestValidator: requestValidator,
      }
    );

    this.webhookUrl = `${api.url}slack-events`;

    // Outputs
    new cdk.CfnOutput(this, 'WebhookURL', {
      value: this.webhookUrl,
      description: 'Slack webhook URL for Events API',
      exportName: `${this.stackName}-WebhookURL`,
    });

    new cdk.CfnOutput(this, 'ProcessingQueueArn', {
      value: processingQueue.queueArn,
      description: 'ARN of the processing queue',
    });
  }
}
