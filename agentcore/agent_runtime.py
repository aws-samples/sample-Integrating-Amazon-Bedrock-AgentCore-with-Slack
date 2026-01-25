"""
Amazon Bedrock Agent Core Runtime - Weather Agent
Uses Agent Core Gateway for MCP tool access with IAM SigV4 authentication
Uses AgentCoreMemorySessionManager for efficient memory management
"""
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from bedrock_agentcore.memory.integrations.strands.config import AgentCoreMemoryConfig
from bedrock_agentcore.memory.integrations.strands.session_manager import AgentCoreMemorySessionManager
from strands import Agent
from strands.models.bedrock import BedrockModel
from strands.tools.mcp import MCPClient
from botocore.credentials import Credentials
from streamable_http_sigv4 import streamablehttp_client_with_sigv4
import os
import boto3
import logging

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize the Agent Core app
app = BedrockAgentCoreApp()

# Get configuration
AWS_REGION = os.environ.get('AWS_REGION', 'us-east-1')
MODEL_ID = os.environ.get('MODEL_ID', 'us.amazon.nova-pro-v1:0')
AGENT_IDENTITY_ARN = os.environ.get('AGENT_IDENTITY_ARN', 'NONE')
GATEWAY_ARN = os.environ.get('GATEWAY_ARN')
MEMORY_ID = os.environ.get('MEMORY_ID')

# Check if Agent Core Identity is enabled
IDENTITY_ENABLED = AGENT_IDENTITY_ARN != 'NONE'

if IDENTITY_ENABLED:
    logger.info(f"Agent Core Identity enabled: {AGENT_IDENTITY_ARN}")
else:
    logger.info("Agent Core Identity not enabled")

if GATEWAY_ARN:
    logger.info(f"Gateway ARN: {GATEWAY_ARN}")
else:
    logger.error("Gateway ARN not configured!")

if MEMORY_ID:
    logger.info(f"Memory ID: {MEMORY_ID}")
else:
    logger.warning("Memory ID not configured")

# Initialize Bedrock model
model = BedrockModel(
    model_id=MODEL_ID,
    region_name=AWS_REGION
)

# Get AWS credentials for SigV4 signing
session = boto3.Session()
credentials = session.get_credentials()
frozen_credentials = Credentials(
    access_key=credentials.access_key,
    secret_key=credentials.secret_key,
    token=credentials.token
)

# Extract Gateway ID from ARN and construct endpoint URL
# ARN format: arn:aws:bedrock-agentcore:region:account:gateway/gateway-id
gateway_id = GATEWAY_ARN.split('/')[-1] if GATEWAY_ARN else None
gateway_endpoint = f"https://{gateway_id}.gateway.bedrock-agentcore.{AWS_REGION}.amazonaws.com/mcp" if gateway_id else None

logger.info(f"Gateway Endpoint: {gateway_endpoint}")

# Global MCP client to keep connection alive
mcp_client = None

def create_agent_with_session_manager(session_id: str, user_id: str):
    """
    Create agent with session-specific memory manager
    
    Args:
        session_id: Slack thread timestamp or session identifier
        user_id: Slack user ID or actor identifier
    
    Returns:
        Agent instance with configured session manager
    """
    global mcp_client
    
    try:
        if not gateway_endpoint:
            logger.error("Cannot initialize: Gateway endpoint not configured")
            return Agent(
                model=model,
                system_prompt="I'm sorry, but I'm not properly configured. Please contact support."
            )
        
        # Initialize MCP client if not already done
        if mcp_client is None:
            logger.info("Initializing MCP Client with SigV4 authentication...")
            mcp_client = MCPClient(lambda: streamablehttp_client_with_sigv4(
                url=gateway_endpoint,
                credentials=frozen_credentials,
                service="bedrock-agentcore",
                region=AWS_REGION
            ))
            mcp_client.__enter__()
            logger.info("MCP Client initialized and connected")
        
        # Get tools from Gateway
        mcp_tools = mcp_client.list_tools_sync()
        logger.info(f"Retrieved {len(mcp_tools)} tools from Gateway")
        
        # Create session manager if memory is configured
        session_manager = None
        if MEMORY_ID:
            try:
                agentcore_memory_config = AgentCoreMemoryConfig(
                    memory_id=MEMORY_ID,
                    session_id=session_id,
                    actor_id=user_id
                )
                
                session_manager = AgentCoreMemorySessionManager(
                    agentcore_memory_config=agentcore_memory_config,
                    region_name=AWS_REGION
                )
                logger.info(f"✅ Session manager configured - Actor: {user_id}, Session: {session_id}")
            except Exception as e:
                logger.error(f"Failed to create session manager: {e}")
                session_manager = None
        
        # Create agent with session manager
        agent = Agent(
            model=model,
            tools=mcp_tools,
            session_manager=session_manager,  # ← Handles memory automatically!
            system_prompt="""You are a helpful weather assistant with access to weather tools.

CRITICAL RULES FOR LOCATION HANDLING:
1. NEVER use a default location (like San Francisco) - if unclear, ask the user
2. ALWAYS mention the city name in your response (e.g., "In New York, the temperature is...")
3. When user asks follow-up questions like "tomorrow", "how about tomorrow", "what about 2 days from now" WITHOUT specifying a location:
   - Check your conversation history for the most recent city/location mentioned
   - Use that same location for the follow-up question
   - If you cannot find any location in the conversation history, then ask the user

CRITICAL RULES FOR ACCURACY - READ CAREFULLY:
1. Tools return JSON strings. You MUST parse them and use ONLY the values in the JSON.
2. DO NOT round, estimate, or modify any numbers from the tool response.
3. DO NOT add weather details that are not in the tool response.
4. DO NOT make assumptions about weather conditions.
5. If the tool returns {"temperature_fahrenheit": 45.2}, you say "45.2°F" - NOT "about 45°F" or "mid-40s".
6. If the tool doesn't provide a value (like humidity), DO NOT mention it.

Available tools:
- get_coordinates(location): Returns JSON with latitude, longitude, display_name
- get_weather(lat, lon): Returns JSON with temperature_fahrenheit, conditions, wind_speed_mph, wind_direction
- get_forecast(lat, lon, days): Returns JSON with forecast array containing date, high_temp_f, low_temp_f, precipitation_probability, conditions
- get_historical_weather(lat, lon, past_days): Returns JSON with historical array
- get_current_time(timezone): Returns JSON with timezone, datetime, formatted

Workflow:
1. Check your conversation history for context (locations mentioned, previous questions)
2. If user asks about weather in a location, first call get_coordinates(location)
3. Then call the appropriate weather tool with the coordinates
4. Parse the JSON response carefully - it will be a string like '{"temperature_fahrenheit": 55, "conditions": "Partly cloudy"}'
5. Extract the exact values and report them without modification
6. ALWAYS include the city name in your response

Example with EXACT tool responses:

User: "What's the weather in Seattle?"
Step 1: Call get_coordinates("Seattle")
Tool returns: '{"latitude": 47.6062, "longitude": -122.3321, "display_name": "Seattle, Washington, USA"}'
Step 2: Call get_weather(47.6062, -122.3321)
Tool returns: '{"temperature_fahrenheit": 55.4, "conditions": "Partly cloudy", "wind_speed_mph": 10.2, "wind_direction": 180}'
Your response: "In Seattle, the current temperature is 55.4°F with partly cloudy skies. Winds are from the south at 10.2 mph."

WRONG responses (DO NOT DO THIS):
- "In Seattle, it's about 55°F..." (you changed 55.4 to "about 55")
- "In Seattle, it's in the mid-50s..." (you rounded instead of using exact value)
- "In Seattle, it's 55°F with partly cloudy skies and moderate humidity" (you added humidity which wasn't in the tool response)

Remember: Use EXACT values from tool responses. Do not round, estimate, or add information."""
        )
        
        logger.info("✅ Agent created successfully with session manager")
        return agent
            
    except Exception as e:
        logger.error(f"Error creating agent: {e}", exc_info=True)
        return Agent(
            model=model,
            system_prompt="I'm sorry, but I'm having trouble accessing my tools right now. Please try again later."
        )

@app.entrypoint
def invoke(payload):
    """
    Process user input and return weather information
    
    Expected payload format:
    {
        "prompt": "What's the weather in Seattle?",
        "sessionId": "optional-session-id",
        "userId": "optional-user-id",  # For Identity-enabled agents
        "accessToken": "optional-jwt-token"  # For Identity-enabled agents
    }
    """
    user_message = payload.get("prompt", "")
    session_id = payload.get("sessionId", "default_session")
    user_id = payload.get("userId", "default_user")
    access_token = payload.get("accessToken")
    
    if not user_message:
        logger.error("No prompt provided in payload")
        return {
            "error": "No prompt provided",
            "message": "Please provide a 'prompt' key in the input"
        }
    
    logger.info(f"Processing request - Session: {session_id}, User: {user_id}, Identity: {IDENTITY_ENABLED}")
    
    # Handle Identity-based authentication if enabled
    if IDENTITY_ENABLED and access_token:
        try:
            # Validate JWT token with Agent Core Identity
            # The token validation is done automatically by the runtime
            logger.info("Using Agent Core Identity for authentication")
        except Exception as e:
            logger.error(f"Identity validation error: {str(e)}")
            return {
                "error": "Authentication failed",
                "message": "Invalid or expired access token"
            }
    
    # Create agent with session-specific memory manager
    # This automatically handles memory retrieval and storage
    agent = create_agent_with_session_manager(session_id, user_id)
    
    # Invoke agent - memory is handled automatically by session manager!
    try:
        logger.info(f"📝 Invoking agent with message: {user_message}")
        result = agent(user_message)
        
        # Log the full agent result for debugging
        logger.info(f"🔍 Full agent result: {result}")
        
        # Extract the final message from the result
        if hasattr(result, 'message'):
            final_message = result.message
        elif hasattr(result, 'content'):
            final_message = result.content
        elif isinstance(result, str):
            final_message = result
        else:
            final_message = str(result)
        
        logger.info(f"Agent result type: {type(result)}, has message: {hasattr(result, 'message')}")
        logger.info(f"📤 Final message being sent: {final_message}")
        
        response = {
            "message": final_message,
            "sessionId": session_id
        }
        
        # Include user context if Identity is enabled
        if IDENTITY_ENABLED and user_id:
            response["userId"] = user_id
        
        logger.info("✅ Request processed successfully")
        return response
        
    except Exception as e:
        logger.error(f"Agent invocation error: {str(e)}")
        return {
            "error": "Agent processing failed",
            "message": str(e),
            "sessionId": session_id
        }

if __name__ == "__main__":
    app.run()
