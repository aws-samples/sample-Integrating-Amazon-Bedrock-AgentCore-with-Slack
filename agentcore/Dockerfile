# Use Python 3.11 ARM64 base image from AWS ECR Public Gallery
FROM --platform=linux/arm64 public.ecr.aws/docker/library/python:3.11-slim

WORKDIR /app

# Upgrade pip
RUN pip install --upgrade pip

# Copy requirements and install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy agent code
COPY agent_runtime.py .
COPY streamable_http_sigv4.py .

# Expose port 8080 (required by Agent Core Runtime)
EXPOSE 8080

# Run the agent directly
CMD ["python", "agent_runtime.py"]
