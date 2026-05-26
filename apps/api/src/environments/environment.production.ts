export const environment = {
  production: true,
  cosmosDb: {
    connectionString: process.env.COSMOSDB_CONNECTION_STRING || '',
    databaseName: process.env.COSMOSDB_DATABASE_NAME || 'meatgeek',
  },
  iotHub: {
    connectionString: process.env.IOTHUB_CONNECTION_STRING || '',
  },
  signalR: {
    connectionString: process.env.SIGNALR_CONNECTION_STRING || '',
  },
  appInsights: {
    connectionString: process.env.APPINSIGHTS_CONNECTION_STRING || '',
  },
};