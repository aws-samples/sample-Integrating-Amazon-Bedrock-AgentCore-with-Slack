import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as path from 'path';
import { Construct } from 'constructs';

export class WeatherAgentImageStack extends cdk.Stack {
  public readonly repository: ecr.Repository;
  public readonly imageUri: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ECR Repository for the agent runtime container
    this.repository = new ecr.Repository(this, 'Repository', {
      repositoryName: 'weather-agent-runtime',
      imageScanOnPush: true,
      lifecycleRules: [
        {
          description: 'Keep last 5 images',
          maxImageCount: 5,
        },
      ],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });

    // S3 bucket for access logs
    const logBucket = new s3.Bucket(this, 'SourceBucketLogs', {
      bucketName: `weather-agent-source-logs-${this.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      enforceSSL: true,
    });

    // S3 bucket for source code
    const sourceBucket = new s3.Bucket(this, 'SourceBucket', {
      bucketName: `weather-agent-source-${this.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      enforceSSL: true,
      serverAccessLogsBucket: logBucket,
      serverAccessLogsPrefix: 'source-bucket-logs/',
    });

    // Upload source files to S3
    const sourceDeployment = new s3deploy.BucketDeployment(this, 'DeploySource', {
      sources: [
        s3deploy.Source.asset(path.join(__dirname, '../../../agentcore')),
      ],
      destinationBucket: sourceBucket,
    });

    // KMS key for CodeBuild encryption
    const encryptionKey = new kms.Key(this, 'BuildEncryptionKey', {
      description: 'KMS key for CodeBuild project encryption',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // CodeBuild project to build and push Docker image
    const buildProject = new codebuild.Project(this, 'BuildProject', {
      projectName: `${this.stackName}-BuildProject`,
      source: codebuild.Source.s3({
        bucket: sourceBucket,
        path: '',
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_ARM_3,
        privileged: true,
        environmentVariables: {
          AWS_DEFAULT_REGION: { value: this.region },
          AWS_ACCOUNT_ID: { value: this.account },
          IMAGE_REPO_NAME: { value: this.repository.repositoryName },
          IMAGE_TAG: { value: 'latest' },
        },
      },
      encryptionKey: encryptionKey,
      logging: {
        cloudWatch: {
          logGroup: new logs.LogGroup(this, 'BuildLogGroup', {
            logGroupName: `/aws/codebuild/${this.stackName}`,
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          }),
        },
        s3: {
          bucket: logBucket,
          prefix: 'codebuild-logs/',
        },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          pre_build: {
            commands: [
              'echo Logging in to Amazon ECR...',
              'aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com',
            ],
          },
          build: {
            commands: [
              'echo Build started on `date`',
              'echo Building the Docker image...',
              'docker build -t $IMAGE_REPO_NAME:$IMAGE_TAG .',
              'docker tag $IMAGE_REPO_NAME:$IMAGE_TAG $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com/$IMAGE_REPO_NAME:$IMAGE_TAG',
            ],
          },
          post_build: {
            commands: [
              'echo Build completed on `date`',
              'echo Pushing the Docker image...',
              'docker push $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com/$IMAGE_REPO_NAME:$IMAGE_TAG',
              'echo Image pushed successfully',
            ],
          },
        },
      }),
    });

    // Grant CodeBuild permissions
    this.repository.grantPullPush(buildProject);
    sourceBucket.grantRead(buildProject);

    // Trigger build on stack creation/update
    const triggerBuild = new cdk.CustomResource(this, 'TriggerBuild', {
      serviceToken: new cdk.custom_resources.Provider(this, 'TriggerBuildProvider', {
        onEventHandler: new cdk.aws_lambda.Function(this, 'TriggerBuildHandler', {
          runtime: cdk.aws_lambda.Runtime.PYTHON_3_11,
          handler: 'index.handler',
          code: cdk.aws_lambda.Code.fromInline(`
import boto3
import cfnresponse
import time

codebuild = boto3.client('codebuild')

def handler(event, context):
    try:
        if event['RequestType'] in ['Create', 'Update']:
            project_name = event['ResourceProperties']['ProjectName']
            response = codebuild.start_build(projectName=project_name)
            build_id = response['build']['id']
            
            # Wait for build to complete
            while True:
                build_info = codebuild.batch_get_builds(ids=[build_id])
                status = build_info['builds'][0]['buildStatus']
                
                if status == 'SUCCEEDED':
                    cfnresponse.send(event, context, cfnresponse.SUCCESS, {'BuildId': build_id})
                    return
                elif status in ['FAILED', 'FAULT', 'TIMED_OUT', 'STOPPED']:
                    cfnresponse.send(event, context, cfnresponse.FAILED, {'Error': f'Build {status}'})
                    return
                
                time.sleep(10)
        else:
            cfnresponse.send(event, context, cfnresponse.SUCCESS, {})
    except Exception as e:
        print(f'Error: {str(e)}')
        cfnresponse.send(event, context, cfnresponse.FAILED, {'Error': str(e)})
          `),
          timeout: cdk.Duration.minutes(15),
          initialPolicy: [
            new iam.PolicyStatement({
              actions: ['codebuild:StartBuild', 'codebuild:BatchGetBuilds'],
              resources: [buildProject.projectArn],
            }),
          ],
        }),
      }).serviceToken,
      properties: {
        ProjectName: buildProject.projectName,
        // Add a timestamp to force rebuild on every deployment
        Timestamp: Date.now().toString(),
      },
    });

    triggerBuild.node.addDependency(buildProject);
    triggerBuild.node.addDependency(sourceDeployment);

    // Image URI for use in other stacks
    this.imageUri = `${this.account}.dkr.ecr.${this.region}.amazonaws.com/${this.repository.repositoryName}:latest`;

    // Outputs
    new cdk.CfnOutput(this, 'RepositoryUri', {
      value: this.repository.repositoryUri,
      description: 'ECR Repository URI',
      exportName: `${this.stackName}-RepositoryUri`,
    });

    new cdk.CfnOutput(this, 'ImageUri', {
      value: this.imageUri,
      description: 'Full Docker image URI',
      exportName: `${this.stackName}-ImageUri`,
    });
  }
}
