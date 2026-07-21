export const environment = {
  production: false,
  cosmosDb: {
    connectionString: process.env['COSMOSDB_CONNECTION_STRING'] || 'AccountEndpoint=https://localhost:8081/;AccountKey=C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==',
    databaseName: process.env['COSMOSDB_DATABASE_NAME'] || 'meatgeek-dev',
  },
  iotHub: {
    connectionString: process.env['IOTHUB_CONNECTION_STRING'] || 'HostName=meatgeek-dev-iothub.azure-devices.net;SharedAccessKeyName=service;SharedAccessKey=fake-key',
  },
  signalR: {
    connectionString: process.env['SIGNALR_CONNECTION_STRING'] || 'Endpoint=https://meatgeek-dev-signalr.service.signalr.net;AccessKey=fake-key;Version=1.0;',
  },
  appInsights: {
    connectionString: process.env['APPLICATIONINSIGHTS_CONNECTION_STRING'] || 'InstrumentationKey=00000000-0000-0000-0000-000000000000',
  },
};