/**
 * MG-51 — COSMOSDB_DATABASE_NAME has NO fallback, deliberately.
 *
 * The removed default was `'meatgeek-dev'`, a database that has never existed in
 * this stack. Terraform owns the real name (`${resource_prefix}-db`) and now
 * publishes it as the COSMOSDB_DATABASE_NAME app setting; nothing in this repo
 * can restate it correctly, because MG-53 will change that value during a
 * migration cutover by editing the Terraform source alone.
 *
 * So the choice was: match what Terraform creates, or fail. FAIL — a fallback
 * here is what produced the defect. A wrong default turns "infrastructure never
 * configured me" into a runtime 404 against a database nobody provisioned,
 * discovered by whoever is debugging the API weeks later; and a fallback that is
 * correct today silently becomes the wrong answer the moment the Terraform value
 * moves. Throwing at module load fails the deployment, not a request.
 */
function requiredFromInfrastructure(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. This value is owned by Terraform (apps/infrastructure) and published as a Function App setting — it has no application default on purpose. See MG-51.`
    );
  }
  return value;
}

export const environment = {
  production: false,
  cosmosDb: {
    connectionString: process.env['COSMOSDB_CONNECTION_STRING'] || 'AccountEndpoint=https://localhost:8081/;AccountKey=C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==',
    databaseName: requiredFromInfrastructure('COSMOSDB_DATABASE_NAME'),
  },
  iotHub: {
    connectionString: process.env['IOTHUB_CONNECTION_STRING'] || 'HostName=meatgeek-dev-iothub.azure-devices.net;SharedAccessKeyName=service;SharedAccessKey=fake-key',
  },
  signalR: {
    connectionString: process.env['SIGNALR_CONNECTION_STRING'] || 'Endpoint=https://meatgeek-dev-signalr.service.signalr.net;AccessKey=fake-key;Version=1.0;',
  },
  appInsights: {
    connectionString: process.env['APPLICATIONINSIGHTS_CONNECTION_STRING'] || '',
  },
};