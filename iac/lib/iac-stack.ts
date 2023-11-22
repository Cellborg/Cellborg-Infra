import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as logs from 'aws-cdk-lib/aws-logs';

export class IacStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const env = this.node.tryGetContext('environment') || 'beta';

    // STEP 0: S3 buckets

    const bucketNames = [
      'datasetupload',
      'qcdataset',
      'pca',
      'heatmap',
      'psuedotime',
      'projectgenenames',
      'genefeatureplot',
      'variablefeature',
      'datasetclusterplot'
    ];

    for (const bucketName of bucketNames) {
      new s3.Bucket(this, `Cellborg-${env}-${bucketName}-Bucket`, {
        bucketName: `cellborg-${env}-${bucketName}-bucket`,
        versioned: true,
        removalPolicy: cdk.RemovalPolicy.DESTROY,  // remove the buckets when stack is deleted
        cors: [
          {
            maxAge: 3000,
            allowedOrigins: [
              'https://beta.cellborg.bio',
              'https://beta.api.cellborg.bio',
              'https://cellborg.bio',
              'https://api.cellborg.bio',
              'http://localhost:3000',
              'http://localhost:4200'
            ], 
            allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT],  
            allowedHeaders: ['*'], 
          },
        ], 
      });
    }

    // STEP 1: VPC & Security Groups
    const vpc = new ec2.Vpc(this, `Cellborg-${env}-VPC`, { maxAzs: 3 });
    const apiSecGroup = new ec2.SecurityGroup(this, 'ApiSecGroup', {
      vpc,
      description: 'Security group for API',
      allowAllOutbound: true
    });
    const frontendSecGroup = new ec2.SecurityGroup(this, 'FrontendSecGroup', {
        vpc,
        description: 'Security group for Frontend',
        allowAllOutbound: true
    });
    apiSecGroup.addIngressRule(frontendSecGroup, ec2.Port.tcp(443), 'Allow frontend to access API on port 443');
    apiSecGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Allow external HTTPS traffic to API');
    frontendSecGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(3000), 'Allow external traffic to Frontend on port 3000');
    
    
    const apiAlbSecGroup = new ec2.SecurityGroup(this, 'ApiAlbSecGroup', {
      vpc,
      description: 'Security group for Api ALB',
      allowAllOutbound: true
    });
    apiAlbSecGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Allow HTTPS traffic');

    const frontendAlbSecGroup = new ec2.SecurityGroup(this, 'FrontendAlbSecGroup', {
      vpc,
      description: 'Security group for Frontend ALB',
      allowAllOutbound: true
    });
    frontendAlbSecGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Allow HTTPS traffic');

    //STEP 2: ECS Clusters (frontend, api, qc, analysis)
    const apiCluster = new ecs.Cluster(this, `Cellborg-${env}-Api-Cluster`, {
      vpc,
      clusterName: `Cellborg-${env}-Api-Cluster`
    });
    const frontendCluster = new ecs.Cluster(this, `Cellborg-${env}-Frontend-Cluster`, {
      vpc,
      clusterName: `Cellborg-${env}-Frontend-Cluster`
    });
    const qcCluster = new ecs.Cluster(this, `Cellborg-${env}-QC-Cluster`, {
      vpc,
      enableFargateCapacityProviders: true,
      clusterName: `Cellborg-${env}-QC-Cluster`
    });
    const analysisCluster = new ecs.Cluster(this, `Cellborg-${env}-Analysis-Cluster`, {
      vpc,
      enableFargateCapacityProviders: true,
      clusterName: `Cellborg-${env}-Analysis-Cluster`
    });

    const apiAutoScalingGroup  = new autoscaling.AutoScalingGroup(this, 'ApiASG', {
      vpc,
      minCapacity: 1,  
      desiredCapacity: 2,  
      maxCapacity: 3, 
      instanceType: new ec2.InstanceType('c5.large'),
      machineImage: ecs.EcsOptimizedImage.amazonLinux2023(),
      spotPrice: '0.04',  // max spot price
      healthCheck: autoscaling.HealthCheck.ec2({ grace: cdk.Duration.seconds(60) }),
      autoScalingGroupName: 'ApiASG',
      securityGroup: apiSecGroup
    });
    const frontendAutoScalingGroup  = new autoscaling.AutoScalingGroup(this, 'FrontendASG', {
      vpc,
      minCapacity: 1,  
      desiredCapacity: 2,  
      maxCapacity: 3, 
      instanceType: new ec2.InstanceType('c5.large'),
      machineImage: ecs.EcsOptimizedImage.amazonLinux2023(),
      spotPrice: '0.04',  // max spot price
      healthCheck: autoscaling.HealthCheck.ec2({ grace: cdk.Duration.seconds(60) }),
      autoScalingGroupName: 'FrontendASG',
      securityGroup: frontendSecGroup
    });

    const apiCapacityProvider = new ecs.AsgCapacityProvider(this, 'ApiAsgCapacityProvider', {
      autoScalingGroup: apiAutoScalingGroup,
      enableManagedScaling: true,
      targetCapacityPercent: 80
    });
    const frontendCapacityProvider = new ecs.AsgCapacityProvider(this, 'FrontendAsgCapacityProvider', {
      autoScalingGroup: frontendAutoScalingGroup,
      enableManagedScaling: true,
      targetCapacityPercent: 80
    });

    frontendCluster.addAsgCapacityProvider(apiCapacityProvider);
    apiCluster.addAsgCapacityProvider(frontendCapacityProvider);
    
    analysisCluster.addDefaultCapacityProviderStrategy([
      {
        capacityProvider: 'FARGATE_SPOT',
        weight: 2,
      },
      {
        capacityProvider: 'FARGATE',
        weight: 1,
      },
    ]);
    qcCluster.addDefaultCapacityProviderStrategy([
      {
        capacityProvider: 'FARGATE_SPOT',
        weight: 2,
      },
      {
        capacityProvider: 'FARGATE',
        weight: 1,
      },
    ])

    // STEP 3: Task Definitions

    // ECR Repositories (assuming they are already created)
    const apiRepo = ecr.Repository.fromRepositoryName(this, 'ApiRepo', `cellborg-${env}-api`);
    const frontendRepo = ecr.Repository.fromRepositoryName(this, 'FrontendRepo', `cellborg-${env}-frontend`);
    const qcRRepo = ecr.Repository.fromRepositoryName(this, 'QcRRepo', `cellborg-${env}-qc_r`);
    const qcPyRepo = ecr.Repository.fromRepositoryName(this, 'QcPyRepo', `cellborg-${env}-qc_py`);
    const analysisRRepo = ecr.Repository.fromRepositoryName(this, 'AnalysisRRepo', `cellborg-${env}-analysis_r`);
    const analysisPyRepo = ecr.Repository.fromRepositoryName(this, 'AnalysisPyRepo', `cellborg-${env}-analysis_py`);

    // Task Definitions
    
    const qcTaskDef = new ecs.FargateTaskDefinition(this, `Cellborg-${env}-QC-Task`, {
      family: `Cellborg-${env}-QC-Task`,
      cpu: 2048,
      memoryLimitMiB: 8192,
      runtimePlatform: {cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX},
      taskRole: iam.Role.fromRoleArn(this, 'QCTaskRole', 'arn:aws:iam::865984939637:role/QC_ECSRole'),
      executionRole: iam.Role.fromRoleArn(this, 'QCExecRole', 'arn:aws:iam::865984939637:role/ecsTaskExecutionRole'),
    });
    qcTaskDef.addContainer(`cellborg-${env}-qc_r`, {
      image: ecs.ContainerImage.fromEcrRepository(qcRRepo, 'latest'),
      cpu: 1024,
      environment: {ENVIRONMENT: env},
      memoryLimitMiB: 4096,
      logging: new ecs.AwsLogDriver({
        streamPrefix: `${env}-qc_r`,
        logGroup: new logs.LogGroup(this, 'QCRLogGroup', {
          logGroupName: `/ecs/${env}-qc_r`,
          removalPolicy: cdk.RemovalPolicy.DESTROY, 
        })
      })
    }).addPortMappings({
      containerPort: 8001,
      protocol: ecs.Protocol.TCP,
      appProtocol: ecs.AppProtocol.http,
      name: 'http'
    });
    qcTaskDef.addContainer(`cellborg-${env}-qc_py`, {
      image: ecs.ContainerImage.fromEcrRepository(qcPyRepo, 'latest'),
      cpu: 1024,
      environment: {ENVIRONMENT: env},
      memoryLimitMiB: 2560,
      logging: new ecs.AwsLogDriver({
        streamPrefix: `${env}-qc_py`,
        logGroup: new logs.LogGroup(this, 'QCPyLogGroup', {
          logGroupName: `/ecs/${env}-qc_py`,
          removalPolicy: cdk.RemovalPolicy.DESTROY, 
        })
      })
    });

    const analysisTaskDef = new ecs.FargateTaskDefinition(this, `Cellborg-${env}-Analysis-Task`, {
      family: `Cellborg-${env}-Analysis-Task`,
      cpu: 2048,
      memoryLimitMiB: 8192,
      runtimePlatform: {cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX},
      taskRole: iam.Role.fromRoleArn(this, 'AnalysisTaskRole', 'arn:aws:iam::865984939637:role/QC_ECSRole', {
        mutable: false,
      }),
      executionRole: iam.Role.fromRoleArn(this, 'AnalysisExecRole', 'arn:aws:iam::865984939637:role/ecsTaskExecutionRole', {
        mutable: false,
      }),
    });
    analysisTaskDef.addContainer(`cellborg-${env}-analysis_py`, {
      image: ecs.ContainerImage.fromEcrRepository(analysisPyRepo, 'latest'),
      cpu: 1024,
      environment: {ENVIRONMENT: env},
      memoryLimitMiB: 2560,
      logging: new ecs.AwsLogDriver({
        streamPrefix: `${env}-analysis_py`,
        logGroup: new logs.LogGroup(this, 'AnalysisPyLogGroup', {
          logGroupName: `/ecs/${env}-analysis_py`,
          removalPolicy: cdk.RemovalPolicy.DESTROY, 
        })
      })
    });
    analysisTaskDef.addContainer(`cellborg-${env}-analysis_r`, {
      image: ecs.ContainerImage.fromEcrRepository(analysisRRepo, 'latest'),
      cpu: 1024,
      environment: {ENVIRONMENT: env},
      memoryLimitMiB: 4096,
      logging: new ecs.AwsLogDriver({
        streamPrefix: `${env}-analysis_r`,
        logGroup: new logs.LogGroup(this, 'AnalysisRLogGroup', {
          logGroupName: `/ecs/${env}-analysis_r`,
          removalPolicy: cdk.RemovalPolicy.DESTROY, 
        })
      })
    }).addPortMappings({
      containerPort: 8001,
      protocol: ecs.Protocol.TCP,
      appProtocol: ecs.AppProtocol.http,
      name: 'http'
    });
    
    const apiTaskDef = new ecs.Ec2TaskDefinition(this, `Cellborg-${env}-Api_Task`, {
      family: `Cellborg-${env}-Api-Task`,
      networkMode: ecs.NetworkMode.AWS_VPC,
      taskRole: iam.Role.fromRoleArn(this, 'ApiTaskRole', 'arn:aws:iam::865984939637:role/ECSec2ServiceTaskRole', {
        mutable: false,
      }),
      executionRole: iam.Role.fromRoleArn(this, 'ApiExecRole', 'arn:aws:iam::865984939637:role/ecsTaskExecutionRole', {
        mutable: false,
      }),
    });
    const apiContainer = apiTaskDef.addContainer(`cellborg-${env}-api`, {
      image: ecs.ContainerImage.fromEcrRepository(apiRepo, 'latest'),
      memoryLimitMiB: 2048,
      cpu: 1024,
      environment: {
        NODE_ENV: env,
        MONGO_CONNECTION_STRING: "mongodb+srv://nishun2005:ktVWftg1tJdMEKZc@users.xtuucul.mongodb.net/?retryWrites=true&w=majority",
        JWT_SECRET: "gBsuHo9HV6D4zrF+HtLBQ1C8n9W7h37W5beOuDXBw0A="
      },
      logging: new ecs.AwsLogDriver({
        streamPrefix: `${env}-ApiService`,
        logGroup: new logs.LogGroup(this, 'ApiServiceLogGroup', {
          logGroupName: `/ecs/${env}-ApiService`,
          removalPolicy: cdk.RemovalPolicy.DESTROY, 
        })
      })
    });
    apiContainer.addPortMappings({
      containerPort: 443,
      protocol: ecs.Protocol.TCP,
      appProtocol: ecs.AppProtocol.http,
      name: 'http'
    });

    const frontendTaskDef = new ecs.Ec2TaskDefinition(this, `Cellborg-${env}-Frontend_Task`, {
      family: `Cellborg-${env}-Frontend-Task`,
      networkMode: ecs.NetworkMode.AWS_VPC,
      taskRole: iam.Role.fromRoleArn(this, 'FrontendTaskRole', 'arn:aws:iam::865984939637:role/ECSec2ServiceTaskRole', {
        mutable: false,
      }),
      executionRole: iam.Role.fromRoleArn(this, 'FrontendExecRole', 'arn:aws:iam::865984939637:role/ecsTaskExecutionRole', {
        mutable: false,
      }),
    });
    const frontendContainer = frontendTaskDef.addContainer(`cellborg-${env}-frontend`, {
      image: ecs.ContainerImage.fromEcrRepository(frontendRepo, 'newest'),
      memoryLimitMiB: 2048,
      cpu: 1024,
      environment: {
        NEXT_PUBLIC_DEPLOY_ENV: env,
        NEXTAUTH_SECRET: "gBsuHo9HV6D4zrF+HtLBQ1C8n9W7h37W5beOuDXBw0A="
      },
      logging: new ecs.AwsLogDriver({
        streamPrefix: `${env}-FrontendService`,
        logGroup: new logs.LogGroup(this, 'FrontendServiceLogGroup', {
          logGroupName: `/ecs/${env}-FrontendService`,
          removalPolicy: cdk.RemovalPolicy.DESTROY, 
        })
      })
    });
    frontendContainer.addPortMappings({
      containerPort: 3000,
      protocol: ecs.Protocol.TCP,
      appProtocol: ecs.AppProtocol.http,
      name: 'http'
    });

    // STEP 4: EC2 Services & Fargate Tasks
    const apiService = new ecsPatterns.ApplicationLoadBalancedEc2Service(this, 'ApiService', {
      cluster: apiCluster,
      taskDefinition: apiTaskDef,
      desiredCount: 1, // Initial count, this will change based on auto-scaling policy
      publicLoadBalancer: true,
      listenerPort: 443,
      serviceName: `Cellborg-${env}-Api`,
      healthCheckGracePeriod: cdk.Duration.seconds(60)
    });
    apiService.loadBalancer.addSecurityGroup(apiAlbSecGroup);
    apiService.targetGroup.configureHealthCheck({
      path: "/api/test"
    });

    const frontendService = new ecsPatterns.ApplicationLoadBalancedEc2Service(this, 'FrontendService', {
      cluster: frontendCluster,
      taskDefinition: frontendTaskDef,
      desiredCount: 1, // Initial count, this will change based on auto-scaling policy
      publicLoadBalancer: true,
      listenerPort: 443,
      serviceName: `Cellborg-${env}-Frontend`,
      healthCheckGracePeriod: cdk.Duration.seconds(60)
    });
    frontendService.loadBalancer.addSecurityGroup(frontendAlbSecGroup);
    frontendService.targetGroup.configureHealthCheck({
      path: "/api/health"
    });
  }
}
