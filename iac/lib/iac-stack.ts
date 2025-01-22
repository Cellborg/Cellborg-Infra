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
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
export class IacStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    
    const env = this.node.tryGetContext('environment') || 'dev'
    const environmentsJSON = this.node.tryGetContext("ENVIRONMENTS")
    const environment = environmentsJSON[env]
    const vpcCIDR = environment["vpc_cidr"]
    const autoScaleProps = environmentsJSON["autoscale_props"]
    
    //getting certificate id's from cdk.json
    const frontendCertificateArn = environment['frontend_cert_arn']
    const apiCertificateArn = environment['api_cert_arn']

    const frontendURL = environment['frontendURL']
    const apiURL = environment['apiURL']

    const frontcertificate = Certificate.fromCertificateArn(this, 'frontendCert', frontendCertificateArn);
    const apicertificate =Certificate.fromCertificateArn(this, 'apiCert', apiCertificateArn)
  
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
            allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.HEAD],  
            allowedHeaders: ['*'], 
          },
        ], 
      });
    }

    // STEP 1: VPC & Security Groups
    const vpc = new ec2.Vpc(this, `Cellborg-${env}-VPC`, {
      maxAzs: 3,
      cidr: vpcCIDR,
      natGateways: 1,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Compute',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        }
      ],
    });
    
    const qcLogGroup = new logs.LogGroup(this, `Cellborg-${env}-QCLogGroup`, {
      logGroupName: `/ecs/Cellborg-${env}-QC-Task`,
      removalPolicy: cdk.RemovalPolicy.DESTROY, 
    });

    const paLogGroup = new logs.LogGroup(this, `Cellborg-${env}-PALogGroup`,{
      logGroupName: `/ecs/Cellborg-${env}-PA-Task`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const analysisLogGroup = new logs.LogGroup(this, `Cellborg-${env}-AnalysisLogGroup`, {
      logGroupName: `/ecs/Cellborg-${env}-Analysis-Task`,
      removalPolicy: cdk.RemovalPolicy.DESTROY, 
    });
    const apiLogGroup = new logs.LogGroup(this, `Cellborg-${env}-ApiLogGroup`, {
      logGroupName: `/ecs/Cellborg-${env}-Api-Task`,
      removalPolicy: cdk.RemovalPolicy.DESTROY, 
    });
    const frontendLogGroup = new logs.LogGroup(this, `Cellborg-${env}-FrontendLogGroup`, {
      logGroupName: `/ecs/Cellborg-${env}-Frontend-Task`,
      removalPolicy: cdk.RemovalPolicy.DESTROY, 
    });

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

    //STEP 2: ECS Clusters (frontend, api, qc, pa, analysis)
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

    const paCluster = new ecs.Cluster(this, `Cellborg-${env}-PA-Cluster`, {
      vpc,
      enableFargateCapacityProviders: true,
      clusterName: `Cellborg-${env}-PA-Cluster`
    })

    const analysisCluster = new ecs.Cluster(this, `Cellborg-${env}-Analysis-Cluster`, {
      vpc,
      enableFargateCapacityProviders: true,
      clusterName: `Cellborg-${env}-Analysis-Cluster`
    });

    const apiAutoScalingGroup  = new autoscaling.AutoScalingGroup(this, 'ApiASG', {
      vpc,
      minCapacity: autoScaleProps.minCapacity,  
      desiredCapacity: autoScaleProps.desiredCapacity,  
      maxCapacity: autoScaleProps.maxCapacity, 
      instanceType: new ec2.InstanceType(autoScaleProps.instanceType),
      machineImage: ecs.EcsOptimizedImage.amazonLinux2023(),
      spotPrice: autoScaleProps.spotPrice,  // max spot price
      healthCheck: autoscaling.HealthCheck.ec2({ grace: cdk.Duration.seconds(60) }),
      autoScalingGroupName: 'ApiASG',
      securityGroup: apiSecGroup
    });
    const frontendAutoScalingGroup  = new autoscaling.AutoScalingGroup(this, 'FrontendASG', {
      vpc,
      minCapacity: autoScaleProps.minCapacity,  
      desiredCapacity: autoScaleProps.desiredCapacity,  
      maxCapacity: autoScaleProps.maxCapacity, 
      instanceType: new ec2.InstanceType(autoScaleProps.instanceType),
      machineImage: ecs.EcsOptimizedImage.amazonLinux2023(),
      spotPrice: autoScaleProps.spotPrice,  // max spot price
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

    paCluster.addDefaultCapacityProviderStrategy([
      {
        capacityProvider: 'FARGATE_SPOT',
        weight:2,
      },
      {
        capacityProvider: 'FARGATE',
        weight: 1
      }
    ])
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
    const qcPyRunnerRepo = ecr.Repository.fromRepositoryName(this, 'QcPyRunnerRepo', `cellborg-${env}-qc_pyrunner`);
    const qcPyRepo = ecr.Repository.fromRepositoryName(this, 'QcPyRepo', `cellborg-${env}-qc_py`);
    const paPyRepo = ecr.Repository.fromRepositoryName(this, 'PaPyRepo', `cellborg-${env}-pa_py`);//change to name of ecr repo (need to create)
    const paPyRunnerRepo = ecr.Repository.fromRepositoryName(this, 'PaPyRunnerRepo',`cellborg-${env}-pa_pyrunner`);//change to name of ecr repo (need to create)
    const analysisRRepo = ecr.Repository.fromRepositoryName(this, 'AnalysisRRepo', `cellborg-${env}-analysis_r`);
    const analysisPyRepo = ecr.Repository.fromRepositoryName(this, 'AnalysisPyRepo', `cellborg-${env}-analysis_py`);

    // Task Definitions
    

    // --------- QC Task Definition --------
    const qcTaskDef = new ecs.FargateTaskDefinition(this, `Cellborg-${env}-QC-Task`, {
      family: `Cellborg-${env}-QC-Task`,
      cpu: 4096,
      memoryLimitMiB: 12288,
      runtimePlatform: {cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX},
      taskRole: iam.Role.fromRoleArn(this, 'QCTaskRole', 'arn:aws:iam::865984939637:role/QC_ECSRole'),
      executionRole: iam.Role.fromRoleArn(this, 'QCExecRole', 'arn:aws:iam::865984939637:role/ecsTaskExecutionRole'),
    });
    const qc_runner_container = new ecs.ContainerDefinition(this,`cellborg-${env}-qc_pyrunner`,{
      taskDefinition: qcTaskDef,
      image: ecs.ContainerImage.fromEcrRepository(qcPyRunnerRepo, 'latest'),
      cpu: 2048,
      environment: {
        ENVIRONMENT: env,
        AWS_ACCESS_KEY_ID: environment['AWS_ACCESS_KEY_ID'],
        AWS_SECRET_ACCESS_KEY: environment['AWS_SECRET_ACCESS_KEY']
      },
      memoryLimitMiB: 8192,
      logging: ecs.LogDrivers.awsLogs({
        logGroup: qcLogGroup,
        streamPrefix: 'ecs',
      }),
      healthCheck: { // Add the health check here
        command: ['CMD-SHELL', 'curl -f http://localhost:8001/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        retries: 5,
        startPeriod: cdk.Duration.seconds(5),
        timeout: cdk.Duration.seconds(2),
      },
    })

    qc_runner_container.addPortMappings({
      containerPort: 8001,
      protocol: ecs.Protocol.TCP,
      appProtocol: ecs.AppProtocol.http,
      name: `cellborg-${env}-qc_pyrunner-8001-tcp`
    });
    

    const qc_py_container = new ecs.ContainerDefinition(this,`cellborg-${env}-qc_py`,{
      taskDefinition: qcTaskDef,
      image: ecs.ContainerImage.fromEcrRepository(qcPyRepo, 'latest'),
      cpu: 1024,
      environment: {ENVIRONMENT: env},
      memoryLimitMiB: 4096,
      logging: ecs.LogDrivers.awsLogs({
        logGroup: qcLogGroup,
        streamPrefix: 'ecs',
      })
    })

    qc_py_container.addContainerDependencies(
      {
        container: qc_runner_container,
        condition: ecs.ContainerDependencyCondition.HEALTHY
      }
    );

    //------ PA Task Definition ------
    const paTaskDef = new ecs.FargateTaskDefinition(this, `Cellborg-${env}-PA-Task`, {
      family: `Cellborg-${env}-PA-Task`,
      cpu: 4096, // adjust cpu allocation
      memoryLimitMiB: 12288, // adjust memory allocation
      runtimePlatform: {cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX},
      taskRole: iam.Role.fromRoleArn(this, 'PATaskRole', 'arn:aws:iam::865984939637:role/QC_ECSRole'),//same permissions as qc
      executionRole: iam.Role.fromRoleArn(this, 'PAExecRole', 'arn:aws:iam::865984939637:role/ecsTaskExecutionRole'),
    });

    const pa_runner_container = new ecs.ContainerDefinition(this,`cellborg-${env}-pa_pyrunner`,{
      taskDefinition: paTaskDef,
      image: ecs.ContainerImage.fromEcrRepository(paPyRunnerRepo, 'latest'),
      cpu: 2048, // change cpu alloc
      environment: {
        ENVIRONMENT: env,
        AWS_ACCESS_KEY_ID: environment['AWS_ACCESS_KEY_ID'],
        AWS_SECRET_ACCESS_KEY: environment['AWS_SECRET_ACCESS_KEY']
      },
      memoryLimitMiB: 8192, //change memory alloc
      logging: ecs.LogDrivers.awsLogs({
        logGroup: paLogGroup,
        streamPrefix: 'ecs',
      }),
      healthCheck: { // Add the health check here
        command: ['CMD-SHELL', 'curl -f http://localhost:8001/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        retries: 5,
        startPeriod: cdk.Duration.seconds(5),
        timeout: cdk.Duration.seconds(2),
      },
    })

    pa_runner_container.addPortMappings({
      containerPort: 8001,
      protocol: ecs.Protocol.TCP,
      appProtocol: ecs.AppProtocol.http,
      name: `cellborg-${env}-pa_pyrunner-8001-tcp`
    });

    const pa_py_container = new ecs.ContainerDefinition(this,`cellborg-${env}-pa_py`,{
      taskDefinition: paTaskDef,
      image: ecs.ContainerImage.fromEcrRepository(paPyRepo, 'latest'),
      cpu: 1024,
      environment: {ENVIRONMENT: env},
      memoryLimitMiB: 4096,
      logging: ecs.LogDrivers.awsLogs({
        logGroup: paLogGroup,
        streamPrefix: 'ecs',
      })
    })

    pa_py_container.addContainerDependencies(
      {
        container: pa_runner_container,
        condition: ecs.ContainerDependencyCondition.HEALTHY
      }
    );



    // ------- Analysis Task Definition -------
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
      logging: ecs.LogDrivers.awsLogs({
        logGroup: analysisLogGroup,
        streamPrefix: 'ecs',
      })
    });
    analysisTaskDef.addContainer(`cellborg-${env}-analysis_r`, {
      image: ecs.ContainerImage.fromEcrRepository(analysisRRepo, 'latest'),
      cpu: 1024,
      environment: {ENVIRONMENT: env},
      memoryLimitMiB: 4096,
      logging: ecs.LogDrivers.awsLogs({
        logGroup: analysisLogGroup,
        streamPrefix: 'ecs',
      })
    }).addPortMappings({
      containerPort: 8001,
      protocol: ecs.Protocol.TCP,
      appProtocol: ecs.AppProtocol.http,
      name: `cellborg-${env}-analysis_r-8001-tcp`
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
      memoryLimitMiB: 1024,
      cpu: 512,
      environment: {
        NODE_ENV: env,
        MONGO_CONNECTION_STRING: "mongodb+srv://nishun2005:ktVWftg1tJdMEKZc@users.xtuucul.mongodb.net/?retryWrites=true&w=majority",
        JWT_SECRET: "gBsuHo9HV6D4zrF+HtLBQ1C8n9W7h37W5beOuDXBw0A="
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup: apiLogGroup,
        streamPrefix: 'ecs',
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
      memoryLimitMiB: 1024,
      cpu: 512,
      environment: {
        NEXT_PUBLIC_DEPLOY_ENV: env,
        NEXTAUTH_SECRET: "gBsuHo9HV6D4zrF+HtLBQ1C8n9W7h37W5beOuDXBw0A=",
        NEXTAUTH_URL: frontendURL
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup: frontendLogGroup,
        streamPrefix: 'ecs',
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
      certificate: apicertificate,
      taskDefinition: apiTaskDef,
      desiredCount: 1, // Initial count, this will change based on auto-scaling policy
      publicLoadBalancer: true,
      protocol: cdk.aws_elasticloadbalancingv2.ApplicationProtocol.HTTPS,
      redirectHTTP: true,
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
      certificate: frontcertificate,
      taskDefinition: frontendTaskDef,
      desiredCount: 1, // Initial count, this will change based on auto-scaling policy
      publicLoadBalancer: true,
      protocol: cdk.aws_elasticloadbalancingv2.ApplicationProtocol.HTTPS,
      redirectHTTP: true,
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
