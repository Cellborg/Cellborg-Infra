const AWS = require('aws-sdk');
const ssm = new AWS.SSM();

exports.handler = async (event) => {
  const documentName = process.env.SSM_DOCUMENT_NAME;
  const instanceId = process.env.INSTANCE_ID;

  const params = {
    DocumentName: documentName,
    InstanceIds: [instanceId]
  };

  await ssm.sendCommand(params).promise();

  return {
    statusCode: 200,
    body: JSON.stringify('SSM command triggered successfully')
  };
};