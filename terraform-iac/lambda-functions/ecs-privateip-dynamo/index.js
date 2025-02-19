const AWS = require('aws-sdk');
const ecs = new AWS.ECS();
const dynamodb = new AWS.DynamoDB.DocumentClient();

exports.handler = async (event) => {
  const cluster = process.env.ECS_CLUSTER;
  const tableName = process.env.DYNAMODB_TABLE;

  const tasks = await ecs.listTasks({ cluster }).promise();
  const taskArns = tasks.taskArns;

  const taskDetails = await ecs.describeTasks({ cluster, tasks: taskArns }).promise();
  const taskIps = taskDetails.tasks.map(task => {
    const container = task.containers[0];
    const networkInterface = container.networkInterfaces[0];
    return {
      taskType: container.name,
      privateIp: networkInterface.privateIpv4Address
    };
  });

  for (const taskIp of taskIps) {
    await dynamodb.put({
      TableName: tableName,
      Item: {
        task_type: taskIp.taskType,
        private_ip: taskIp.privateIp
      }
    }).promise();
  }

  return {
    statusCode: 200,
    body: JSON.stringify('Task IPs updated successfully')
  };
};