import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as agentcore from '@aws-cdk/aws-bedrock-agentcore-alpha';
import { Construct } from 'constructs';

export interface WeatherAgentCoreStackProps extends cdk.StackProps {
  imageUri: string;
  foundationModel?: string;
}

export class WeatherAgentCoreStack extends cdk.Stack {
  public readonly runtimeArn: string;
  public readonly gatewayArn: string;
  public readonly memoryId: string;

  constructor(scope: Construct, id: string, props: WeatherAgentCoreStackProps) {
    super(scope, id, props);

    const foundationModel = props.foundationModel || 'us.amazon.nova-pro-v1:0';
    const accountId = cdk.Stack.of(this).account;
    const region = cdk.Stack.of(this).region;

    // IAM Role for Agent Runtime
    const agentRole = new iam.Role(this, 'AgentRole', {
      roleName: `${this.stackName}-weather-agent-role`,
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('BedrockAgentCoreFullAccess'),
      ],
    });

    // MCP Server Lambda Function (v2.2 - Gateway-compatible format)
    // Gateway handles tools/list - Lambda only handles tools/call
    // Gateway sends: {name: "tool_name", arguments: {...}}
    // Lambda returns: {content: [{type: "text", text: "..."}]}
    const mcpServer = new lambda.Function(this, 'MCPServer', {
      functionName: `${this.stackName}-mcp-server`,
      runtime: lambda.Runtime.PYTHON_3_14,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
import json, urllib.request, urllib.parse, os
from datetime import datetime
from zoneinfo import ZoneInfo

LOG_LEVEL = os.environ.get('LOG_LEVEL', 'INFO').upper()

def log_debug(msg):
    if LOG_LEVEL == 'DEBUG':
        print(f"[DEBUG] {msg}")

def log_info(msg):
    if LOG_LEVEL in ['DEBUG', 'INFO']:
        print(f"[INFO] {msg}")

def log_error(msg):
    print(f"[ERROR] {msg}")

def handler(event, context):
    """
    Gateway sends tool arguments directly based on tool routing
    Event format: {argument1: value1, argument2: value2, ...}
    Lambda should return: {content: [{type: "text", text: "..."}]}
    
    Gateway routes to this Lambda based on tool name in target config,
    so we need to detect which tool was called based on the arguments present.
    """
    log_debug(f"Received event: {json.dumps(event)}")
    
    try:
        # Detect which tool based on arguments
        if 'timezone' in event:
            # get_current_time tool
            result = get_time(event.get('timezone', 'UTC'))
        elif 'location' in event:
            # get_coordinates tool
            result = get_coords(event.get('location'))
        elif 'latitude' in event and 'longitude' in event:
            # Check if it's forecast or historical based on presence of 'days' or 'past_days'
            if 'days' in event:
                # get_forecast tool
                result = get_forecast(event.get('latitude'), event.get('longitude'), event.get('days', 5))
            elif 'past_days' in event:
                # get_historical_weather tool
                result = get_historical(event.get('latitude'), event.get('longitude'), event.get('past_days', 5))
            else:
                # get_weather tool (current weather)
                result = get_weather(event.get('latitude'), event.get('longitude'))
        else:
            result = {'content': [{'type': 'text', 'text': json.dumps({'error': f'Unknown tool arguments: {list(event.keys())}'})}]}
        
        log_debug(f"Result: {json.dumps(result)}")
        return result
        
    except Exception as e:
        log_error(f"Error: {str(e)}")
        import traceback
        traceback.print_exc()
        return {'content': [{'type': 'text', 'text': json.dumps({'error': str(e)})}]}

def get_time(tz):
    try:
        zone = ZoneInfo(tz) if tz.upper() != 'AUTO' else ZoneInfo('UTC')
        now = datetime.now(zone)
        return {'content': [{'type': 'text', 'text': json.dumps({'timezone': tz, 'datetime': now.isoformat(), 'formatted': now.strftime('%A, %B %d, %Y at %I:%M %p %Z')})}]}
    except Exception as e:
        return {'content': [{'type': 'text', 'text': json.dumps({'error': f'Invalid timezone: {str(e)}'})}]}

def get_coords(loc):
    try:
        url = f"https://nominatim.openstreetmap.org/search?q={urllib.parse.quote(loc)}&format=json&limit=1"
        req = urllib.request.Request(url, headers={'User-Agent': 'AWS-Weather/1.0'})
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read().decode())
        if data:
            return {'content': [{'type': 'text', 'text': json.dumps({'latitude': float(data[0]['lat']), 'longitude': float(data[0]['lon']), 'display_name': data[0]['display_name']})}]}
        return {'content': [{'type': 'text', 'text': json.dumps({'error': 'Location not found'})}]}
    except Exception as e:
        return {'content': [{'type': 'text', 'text': json.dumps({'error': f'Geocoding error: {str(e)}'})}]}

def get_weather(lat, lon):
    try:
        url = f"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&current_weather=true&temperature_unit=fahrenheit&windspeed_unit=mph"
        with urllib.request.urlopen(url, timeout=10) as r:
            data = json.loads(r.read().decode())
        log_debug(f"Weather API response for ({lat}, {lon}): {json.dumps(data)}")
        current = data.get('current_weather', {})
        weather_codes = {0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Foggy', 48: 'Depositing rime fog', 51: 'Light drizzle', 53: 'Moderate drizzle', 55: 'Dense drizzle', 61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain', 71: 'Slight snow', 73: 'Moderate snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Slight rain showers', 81: 'Moderate rain showers', 82: 'Violent rain showers', 85: 'Slight snow showers', 86: 'Heavy snow showers', 95: 'Thunderstorm', 96: 'Thunderstorm with slight hail', 99: 'Thunderstorm with heavy hail'}
        result = {'content': [{'type': 'text', 'text': json.dumps({'temperature_fahrenheit': current.get('temperature'), 'conditions': weather_codes.get(current.get('weathercode', 0), 'Unknown'), 'wind_speed_mph': current.get('windspeed'), 'wind_direction': current.get('winddirection')})}]}
        log_debug(f"Returning weather result: {json.dumps(result)}")
        return result
    except Exception as e:
        return {'content': [{'type': 'text', 'text': json.dumps({'error': f'Weather API error: {str(e)}'})}]}

def get_forecast(lat, lon, days=5):
    try:
        url = f"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weathercode&temperature_unit=fahrenheit&timezone=auto&forecast_days={min(days, 7)}"
        with urllib.request.urlopen(url, timeout=10) as r:
            data = json.loads(r.read().decode())
        log_debug(f"Forecast API response for ({lat}, {lon}), {days} days: {json.dumps(data)}")
        daily = data.get('daily', {})
        weather_codes = {0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Foggy', 48: 'Depositing rime fog', 51: 'Light drizzle', 53: 'Moderate drizzle', 55: 'Dense drizzle', 61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain', 71: 'Slight snow', 73: 'Moderate snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Slight rain showers', 81: 'Moderate rain showers', 82: 'Violent rain showers', 85: 'Slight snow showers', 86: 'Heavy snow showers', 95: 'Thunderstorm', 96: 'Thunderstorm with slight hail', 99: 'Thunderstorm with heavy hail'}
        forecast = []
        for i in range(len(daily.get('time', []))):
            forecast.append({'date': daily['time'][i], 'high_temp_f': daily['temperature_2m_max'][i], 'low_temp_f': daily['temperature_2m_min'][i], 'precipitation_probability': daily['precipitation_probability_max'][i], 'conditions': weather_codes.get(daily['weathercode'][i], 'Unknown')})
        result = {'content': [{'type': 'text', 'text': json.dumps({'forecast_days': len(forecast), 'forecast': forecast})}]}
        log_debug(f"Returning forecast result: {json.dumps(result)}")
        return result
    except Exception as e:
        return {'content': [{'type': 'text', 'text': json.dumps({'error': f'Forecast API error: {str(e)}'})}]}

def get_historical(lat, lon, past_days=5):
    try:
        url = f"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&past_days={min(past_days, 92)}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode&temperature_unit=fahrenheit&timezone=auto"
        with urllib.request.urlopen(url, timeout=10) as r:
            data = json.loads(r.read().decode())
        daily = data.get('daily', {})
        weather_codes = {0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Foggy', 48: 'Depositing rime fog', 51: 'Light drizzle', 53: 'Moderate drizzle', 55: 'Dense drizzle', 61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain', 71: 'Slight snow', 73: 'Moderate snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Slight rain showers', 81: 'Moderate rain showers', 82: 'Violent rain showers', 85: 'Slight snow showers', 86: 'Heavy snow showers', 95: 'Thunderstorm', 96: 'Thunderstorm with slight hail', 99: 'Thunderstorm with heavy hail'}
        historical = []
        for i in range(len(daily.get('time', []))):
            historical.append({'date': daily['time'][i], 'high_temp_f': daily['temperature_2m_max'][i], 'low_temp_f': daily['temperature_2m_min'][i], 'precipitation_inches': daily['precipitation_sum'][i], 'conditions': weather_codes.get(daily['weathercode'][i], 'Unknown')})
        return {'content': [{'type': 'text', 'text': json.dumps({'historical_days': len(historical), 'historical': historical})}]}
    except Exception as e:
        return {'content': [{'type': 'text', 'text': json.dumps({'error': f'Historical API error: {str(e)}'})}]}
      `),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        LOG_LEVEL: 'INFO', // Set to 'DEBUG' for verbose logging, 'INFO' for production
      },
    });

    // Create execution role for Gateway (following AWS sample pattern with least privilege)
    const gatewayExecutionRole = new iam.Role(this, 'GatewayExecutionRole', {
      roleName: `${this.stackName}-gateway-execution-role`,
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      description: 'Execution role for AgentCore Gateway to invoke Lambda',
    });

    // Grant permission to invoke only the specific MCP Lambda function
    mcpServer.grantInvoke(gatewayExecutionRole);

    // Add CloudWatch Logs permissions (scoped to this stack's log groups)
    gatewayExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
        ],
        resources: [
          `arn:aws:logs:${region}:${accountId}:log-group:/aws/bedrock-agentcore/${this.stackName}*`,
        ],
      })
    );

    // Agent Core Gateway with IAM authentication and execution role
    const gateway = new agentcore.Gateway(this, 'Gateway', {
      gatewayName: `${this.stackName}-gateway`,
      description: 'Weather MCP Gateway',
      authorizerConfiguration: agentcore.GatewayAuthorizer.usingAwsIam(),
    });

    // Use escape hatch to add the execution role to the underlying CloudFormation resource
    const cfnGateway = gateway.node.defaultChild as cdk.CfnResource;
    cfnGateway.addPropertyOverride('RoleArn', gatewayExecutionRole.roleArn);

    // Add Lambda target to Gateway using the new API
    const gatewayTarget = gateway.addLambdaTarget('WeatherTarget', {
      gatewayTargetName: 'WeatherTarget',
      description: 'Weather tools MCP Lambda target',
      lambdaFunction: mcpServer,
      toolSchema: agentcore.ToolSchema.fromInline([
        {
          name: 'get_current_time',
          description: 'Get current time for timezone',
          inputSchema: {
            type: agentcore.SchemaDefinitionType.OBJECT,
            properties: {
              timezone: { 
                type: agentcore.SchemaDefinitionType.STRING, 
                description: 'Timezone name like America/Chicago or UTC' 
              },
            },
            required: ['timezone'],
          },
        },
        {
          name: 'get_coordinates',
          description: 'Get latitude/longitude for location',
          inputSchema: {
            type: agentcore.SchemaDefinitionType.OBJECT,
            properties: {
              location: { 
                type: agentcore.SchemaDefinitionType.STRING, 
                description: 'City name or address' 
              },
            },
            required: ['location'],
          },
        },
        {
          name: 'get_weather',
          description: 'Get current weather for coordinates',
          inputSchema: {
            type: agentcore.SchemaDefinitionType.OBJECT,
            properties: {
              latitude: { 
                type: agentcore.SchemaDefinitionType.NUMBER, 
                description: 'Latitude' 
              },
              longitude: { 
                type: agentcore.SchemaDefinitionType.NUMBER, 
                description: 'Longitude' 
              },
            },
            required: ['latitude', 'longitude'],
          },
        },
        {
          name: 'get_forecast',
          description: 'Get weather forecast for next 1-5 days for coordinates',
          inputSchema: {
            type: agentcore.SchemaDefinitionType.OBJECT,
            properties: {
              latitude: { 
                type: agentcore.SchemaDefinitionType.NUMBER, 
                description: 'Latitude' 
              },
              longitude: { 
                type: agentcore.SchemaDefinitionType.NUMBER, 
                description: 'Longitude' 
              },
              days: { 
                type: agentcore.SchemaDefinitionType.NUMBER, 
                description: 'Number of forecast days (1-5, default 5)' 
              },
            },
            required: ['latitude', 'longitude'],
          },
        },
        {
          name: 'get_historical_weather',
          description: 'Get historical weather data for past 1-5 days for coordinates',
          inputSchema: {
            type: agentcore.SchemaDefinitionType.OBJECT,
            properties: {
              latitude: { 
                type: agentcore.SchemaDefinitionType.NUMBER, 
                description: 'Latitude' 
              },
              longitude: { 
                type: agentcore.SchemaDefinitionType.NUMBER, 
                description: 'Longitude' 
              },
              past_days: { 
                type: agentcore.SchemaDefinitionType.NUMBER, 
                description: 'Number of past days (1-5, default 5)' 
              },
            },
            required: ['latitude', 'longitude'],
          },
        },
      ]),
    });

    // Add explicit CloudFormation dependency to ensure IAM policy propagation
    // This forces CloudFormation to wait for the IAM policy to be created before
    // attempting to create the Gateway Target, giving time for IAM propagation
    const cfnGatewayTarget = gatewayTarget.node.defaultChild as cdk.CfnResource;
    const gatewayRolePolicy = gatewayExecutionRole.node.findChild('DefaultPolicy').node.defaultChild as cdk.CfnResource;
    cfnGatewayTarget.addDependency(gatewayRolePolicy);

    // Grant agent role permissions
    agentRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [`arn:aws:logs:${region}:${accountId}:log-group:/aws/bedrock-agentcore/runtimes/weatheragent_runtime*`],
      })
    );

    agentRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:Converse', 'bedrock:ConverseStream'],
        resources: [
          `arn:aws:bedrock:*::foundation-model/${foundationModel}`,
          `arn:aws:bedrock:*:${this.account}:inference-profile/${foundationModel}`,
        ],
      })
    );

    agentRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock-agentcore:InvokeGateway'],
        resources: [gateway.gatewayArn],
      })
    );

    // Note: ecr:GetAuthorizationToken does not support resource-level permissions per AWS documentation
    agentRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      })
    );

    agentRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'],
        resources: [`arn:aws:ecr:${this.region}:${this.account}:repository/weather-agent-runtime`],
      })
    );

    // Agent Core Memory
    const memory = new agentcore.Memory(this, 'Memory', {
      memoryName: 'weatheragent_memory',
      description: 'Memory store for weather agent',
      expirationDuration: cdk.Duration.days(90),
    });

    // Construct Gateway endpoint URL from ARN
    // ARN format: arn:aws:bedrock-agentcore:region:account:gateway/gateway-id
    const gatewayId = cdk.Fn.select(1, cdk.Fn.split('/', gateway.gatewayArn));
    const gatewayEndpoint = `https://${gatewayId}.gateway.bedrock-agentcore.${region}.amazonaws.com`;

    // Agent Core Runtime with Gateway Configuration
    const runtime = new agentcore.Runtime(this, 'Runtime', {
      runtimeName: 'weatheragent_runtime',
      description: 'Weather agent with Slack integration (v2 - Gateway-based)',
      executionRole: agentRole,
      agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromImageUri(props.imageUri),
      networkConfiguration: agentcore.RuntimeNetworkConfiguration.usingPublicNetwork(),
      environmentVariables: {
        'GATEWAY_ARN': gateway.gatewayArn,
        'MEMORY_ID': memory.memoryId,
        'MODEL_ID': foundationModel,
        'AWS_REGION': region,
      },
    });

    this.runtimeArn = runtime.agentRuntimeArn;
    this.gatewayArn = gateway.gatewayArn;
    this.memoryId = memory.memoryId;

    // Outputs
    new cdk.CfnOutput(this, 'RuntimeArn', {
      value: this.runtimeArn,
      description: 'Agent Core Runtime ARN',
      exportName: `${this.stackName}-RuntimeArn`,
    });

    new cdk.CfnOutput(this, 'GatewayArn', {
      value: this.gatewayArn,
      description: 'Agent Core Gateway ARN',
      exportName: `${this.stackName}-GatewayArn`,
    });

    new cdk.CfnOutput(this, 'GatewayEndpoint', {
      value: gatewayEndpoint,
      description: 'Agent Core Gateway Endpoint URL',
      exportName: `${this.stackName}-GatewayEndpoint`,
    });

    new cdk.CfnOutput(this, 'MemoryId', {
      value: this.memoryId,
      description: 'Agent Core Memory ID',
      exportName: `${this.stackName}-MemoryId`,
    });
  }
}
