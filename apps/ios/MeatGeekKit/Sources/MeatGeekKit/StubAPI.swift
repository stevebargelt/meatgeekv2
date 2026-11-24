import Foundation
public import MeatGeekAPI

/// An in-process `APIProtocol` (the generated client's protocol) with no
/// network behind it: each operation calls its `<operationId>Handler`, and a
/// handler nobody set throws `StubAPI.NotStubbed`.
///
/// The app uses `StubAPI.uiTest()` instead of the real client when launched
/// with `MEATGEEK_UI_TEST=1` (see `UITestMode`); unit tests set the handlers
/// they need. To give UI test mode a new screen's data, set that operation's
/// handler in `uiTest()`; when the spec gains an operation, add its handler
/// and method here (the compiler lists what is missing).
public struct StubAPI: APIProtocol {
    /// Thrown by an operation whose handler was not set.
    public struct NotStubbed: Error, Equatable, Sendable {
        public let operationID: String
    }

    public init() {}

    public var listCooksHandler: @Sendable (Operations.ListCooks.Input) async throws -> Operations.ListCooks.Output
        = { _ in throw NotStubbed(operationID: "listCooks") }
    public var startCookHandler: @Sendable (Operations.StartCook.Input) async throws -> Operations.StartCook.Output
        = { _ in throw NotStubbed(operationID: "startCook") }
    public var getCookHandler: @Sendable (Operations.GetCook.Input) async throws -> Operations.GetCook.Output
        = { _ in throw NotStubbed(operationID: "getCook") }
    public var getCookChartHandler: @Sendable (Operations.GetCookChart.Input) async throws -> Operations.GetCookChart.Output
        = { _ in throw NotStubbed(operationID: "getCookChart") }
    public var stopCookHandler: @Sendable (Operations.StopCook.Input) async throws -> Operations.StopCook.Output
        = { _ in throw NotStubbed(operationID: "stopCook") }
    public var negotiateHandler: @Sendable (Operations.Negotiate.Input) async throws -> Operations.Negotiate.Output
        = { _ in throw NotStubbed(operationID: "negotiate") }
    public var getCurrentTemperaturesHandler: @Sendable (Operations.GetCurrentTemperatures.Input) async throws -> Operations.GetCurrentTemperatures.Output
        = { _ in throw NotStubbed(operationID: "getCurrentTemperatures") }
    public var getTemperatureHistoryHandler: @Sendable (Operations.GetTemperatureHistory.Input) async throws -> Operations.GetTemperatureHistory.Output
        = { _ in throw NotStubbed(operationID: "getTemperatureHistory") }
    public var getDevicesHandler: @Sendable (Operations.GetDevices.Input) async throws -> Operations.GetDevices.Output
        = { _ in throw NotStubbed(operationID: "getDevices") }
    public var claimDeviceHandler: @Sendable (Operations.ClaimDevice.Input) async throws -> Operations.ClaimDevice.Output
        = { _ in throw NotStubbed(operationID: "claimDevice") }
    public var getDeviceHandler: @Sendable (Operations.GetDevice.Input) async throws -> Operations.GetDevice.Output
        = { _ in throw NotStubbed(operationID: "getDevice") }
    public var updateDeviceHandler: @Sendable (Operations.UpdateDevice.Input) async throws -> Operations.UpdateDevice.Output
        = { _ in throw NotStubbed(operationID: "updateDevice") }
    public var deleteDeviceHandler: @Sendable (Operations.DeleteDevice.Input) async throws -> Operations.DeleteDevice.Output
        = { _ in throw NotStubbed(operationID: "deleteDevice") }
    public var getUserProfileHandler: @Sendable (Operations.GetUserProfile.Input) async throws -> Operations.GetUserProfile.Output
        = { _ in throw NotStubbed(operationID: "getUserProfile") }
    public var putUserProfileHandler: @Sendable (Operations.PutUserProfile.Input) async throws -> Operations.PutUserProfile.Output
        = { _ in throw NotStubbed(operationID: "putUserProfile") }
    public var listRecipesHandler: @Sendable (Operations.ListRecipes.Input) async throws -> Operations.ListRecipes.Output
        = { _ in throw NotStubbed(operationID: "listRecipes") }
    public var createRecipeHandler: @Sendable (Operations.CreateRecipe.Input) async throws -> Operations.CreateRecipe.Output
        = { _ in throw NotStubbed(operationID: "createRecipe") }
    public var getRecipeHandler: @Sendable (Operations.GetRecipe.Input) async throws -> Operations.GetRecipe.Output
        = { _ in throw NotStubbed(operationID: "getRecipe") }
    public var updateRecipeHandler: @Sendable (Operations.UpdateRecipe.Input) async throws -> Operations.UpdateRecipe.Output
        = { _ in throw NotStubbed(operationID: "updateRecipe") }
    public var deleteRecipeHandler: @Sendable (Operations.DeleteRecipe.Input) async throws -> Operations.DeleteRecipe.Output
        = { _ in throw NotStubbed(operationID: "deleteRecipe") }
    public var getCosmosHealthHandler: @Sendable (Operations.GetCosmosHealth.Input) async throws -> Operations.GetCosmosHealth.Output
        = { _ in throw NotStubbed(operationID: "getCosmosHealth") }
}

extension StubAPI {
    public func listCooks(_ input: Operations.ListCooks.Input) async throws -> Operations.ListCooks.Output {
        try await listCooksHandler(input)
    }

    public func startCook(_ input: Operations.StartCook.Input) async throws -> Operations.StartCook.Output {
        try await startCookHandler(input)
    }

    public func getCook(_ input: Operations.GetCook.Input) async throws -> Operations.GetCook.Output {
        try await getCookHandler(input)
    }

    public func getCookChart(_ input: Operations.GetCookChart.Input) async throws -> Operations.GetCookChart.Output {
        try await getCookChartHandler(input)
    }

    public func stopCook(_ input: Operations.StopCook.Input) async throws -> Operations.StopCook.Output {
        try await stopCookHandler(input)
    }

    public func negotiate(_ input: Operations.Negotiate.Input) async throws -> Operations.Negotiate.Output {
        try await negotiateHandler(input)
    }

    public func getCurrentTemperatures(_ input: Operations.GetCurrentTemperatures.Input) async throws -> Operations.GetCurrentTemperatures.Output {
        try await getCurrentTemperaturesHandler(input)
    }

    public func getTemperatureHistory(_ input: Operations.GetTemperatureHistory.Input) async throws -> Operations.GetTemperatureHistory.Output {
        try await getTemperatureHistoryHandler(input)
    }

    public func getDevices(_ input: Operations.GetDevices.Input) async throws -> Operations.GetDevices.Output {
        try await getDevicesHandler(input)
    }

    public func claimDevice(_ input: Operations.ClaimDevice.Input) async throws -> Operations.ClaimDevice.Output {
        try await claimDeviceHandler(input)
    }

    public func getDevice(_ input: Operations.GetDevice.Input) async throws -> Operations.GetDevice.Output {
        try await getDeviceHandler(input)
    }

    public func updateDevice(_ input: Operations.UpdateDevice.Input) async throws -> Operations.UpdateDevice.Output {
        try await updateDeviceHandler(input)
    }

    public func deleteDevice(_ input: Operations.DeleteDevice.Input) async throws -> Operations.DeleteDevice.Output {
        try await deleteDeviceHandler(input)
    }

    public func getUserProfile(_ input: Operations.GetUserProfile.Input) async throws -> Operations.GetUserProfile.Output {
        try await getUserProfileHandler(input)
    }

    public func putUserProfile(_ input: Operations.PutUserProfile.Input) async throws -> Operations.PutUserProfile.Output {
        try await putUserProfileHandler(input)
    }

    public func listRecipes(_ input: Operations.ListRecipes.Input) async throws -> Operations.ListRecipes.Output {
        try await listRecipesHandler(input)
    }

    public func createRecipe(_ input: Operations.CreateRecipe.Input) async throws -> Operations.CreateRecipe.Output {
        try await createRecipeHandler(input)
    }

    public func getRecipe(_ input: Operations.GetRecipe.Input) async throws -> Operations.GetRecipe.Output {
        try await getRecipeHandler(input)
    }

    public func updateRecipe(_ input: Operations.UpdateRecipe.Input) async throws -> Operations.UpdateRecipe.Output {
        try await updateRecipeHandler(input)
    }

    public func deleteRecipe(_ input: Operations.DeleteRecipe.Input) async throws -> Operations.DeleteRecipe.Output {
        try await deleteRecipeHandler(input)
    }

    public func getCosmosHealth(_ input: Operations.GetCosmosHealth.Input) async throws -> Operations.GetCosmosHealth.Output {
        try await getCosmosHealthHandler(input)
    }
}

extension StubAPI {
    /// The user UI test mode's `GET /users/me` returns.
    public static let uiTestUserName = "Pat Pitmaster"

    /// The stub the app runs on in UI test mode: `GET /users/me` answers
    /// `uiTestUserName`; every other operation is not stubbed yet.
    public static func uiTest() -> StubAPI {
        var api = StubAPI()
        api.getUserProfileHandler = { _ in .ok(.init(body: .json(try user(name: uiTestUserName)))) }
        return api
    }

    /// A `User` as `GET /users/me` returns it, with the API's default
    /// preferences (DEFAULT_USER_PREFERENCES in
    /// apps/api/src/shared/cosmos/users-repository.ts).
    public static func user(name: String) throws -> Components.Schemas.User {
        let body = """
        {
          "id": "tid:oid",
          "email": "pat@example.test",
          "name": \(String(decoding: try JSONEncoder().encode(name), as: UTF8.self)),
          "preferences": {
            "temperatureUnit": "fahrenheit",
            "timeZone": "UTC",
            "notifications": {
              "tempAlerts": true,
              "cookComplete": true,
              "deviceOffline": true,
              "weeklyReports": false,
              "productUpdates": false,
              "pushNotifications": {
                "enabled": true,
                "sound": true,
                "vibration": true,
                "quietHours": { "enabled": false, "startTime": "22:00", "endTime": "07:00" }
              },
              "email": { "enabled": false, "frequency": "daily" },
              "sms": { "enabled": false }
            },
            "defaultTargetTemps": {},
            "privacy": { "shareData": false, "publicProfile": false, "allowAnalytics": false },
            "display": { "theme": "auto", "compactMode": false, "showAdvancedMetrics": false }
          },
          "devices": ["meatgeek3"],
          "createdAt": "2026-11-20T15:00:00.000Z"
        }
        """
        return try APIClientFactory.makeJSONDecoder().decode(Components.Schemas.User.self, from: Data(body.utf8))
    }
}
