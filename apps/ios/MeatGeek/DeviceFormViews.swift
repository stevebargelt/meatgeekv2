import MeatGeekKit
import SwiftUI
import UIKit

/// Claim a device with the ID and code it prints. A sheet over the devices list.
struct ClaimDeviceView: View {
    @State var model: ClaimDeviceModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Run the setup command on your device. It prints the device ID and a claim code; enter both here.")
                        .foregroundStyle(.secondary)
                }
                Section {
                    TextField("Device ID", text: $model.deviceID)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier(AccessibilityID.claimDeviceID)
                    FieldError(message: model.fieldErrors.deviceID)
                    LabeledContent("Claim code") {
                        ClaimCodeField(text: $model.claimCode)
                    }
                    FieldError(message: model.fieldErrors.claimCode)
                    TextField("Name", text: $model.name)
                        .accessibilityIdentifier(AccessibilityID.claimName)
                    FieldError(message: model.fieldErrors.name)
                    TextField("Location (optional)", text: $model.location)
                        .accessibilityIdentifier(AccessibilityID.claimLocation)
                    FieldError(message: model.fieldErrors.location)
                }
                if let problem = model.problem {
                    Section {
                        ProblemText(problem: problem)
                            .accessibilityIdentifier(AccessibilityID.claimProblem)
                    }
                }
            }
            .navigationTitle("Claim a device")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .accessibilityIdentifier(AccessibilityID.claimCancel)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(model.submitting ? "Claiming…" : "Claim") {
                        Task {
                            if await model.submit() != nil { dismiss() }
                        }
                    }
                    .disabled(model.submitting)
                    .accessibilityIdentifier(AccessibilityID.claimSubmit)
                }
            }
            .interactiveDismissDisabled(model.submitting)
        }
    }
}

/// A new name for one device. A sheet over the list or the detail screen.
struct RenameDeviceView: View {
    @State var model: RenameDeviceModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                TextField("Name", text: $model.name)
                    .accessibilityIdentifier(AccessibilityID.renameName)
                if let problem = model.problem {
                    ProblemText(problem: problem)
                        .accessibilityIdentifier(AccessibilityID.renameProblem)
                }
            }
            .navigationTitle("Rename device")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .accessibilityIdentifier(AccessibilityID.renameCancel)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(model.saving ? "Saving…" : "Save") {
                        Task {
                            if await model.save() { dismiss() }
                        }
                    }
                    .disabled(model.saving)
                    .accessibilityIdentifier(AccessibilityID.renameSave)
                }
            }
            .interactiveDismissDisabled(model.saving)
        }
        .presentationDetents([.medium])
    }
}

/// A field's validation message, under the field.
private struct FieldError: View {
    let message: String?

    var body: some View {
        if let message {
            Text(message)
                .font(.footnote)
                .foregroundStyle(.red)
        }
    }
}

/// The claim code field: formatted as typed (`ClaimCode.format`), with the
/// caret kept after the same symbols. A UITextField whose delegate applies
/// each edit itself: a SwiftUI TextField sometimes keeps showing what was
/// typed instead of the value its binding formatted.
struct ClaimCodeField: UIViewRepresentable {
    @Binding var text: String

    func makeUIView(context: Context) -> UITextField {
        let field = UITextField()
        field.placeholder = "XXXX-XXXX-XXXX"
        field.autocapitalizationType = .allCharacters
        field.autocorrectionType = .no
        field.spellCheckingType = .no
        field.smartDashesType = .no
        field.smartInsertDeleteType = .no
        field.textAlignment = .right
        field.font = UIFontMetrics(forTextStyle: .body).scaledFont(
            for: .monospacedSystemFont(ofSize: UIFont.preferredFont(forTextStyle: .body).pointSize, weight: .regular)
        )
        field.adjustsFontForContentSizeCategory = true
        field.accessibilityIdentifier = AccessibilityID.claimCode
        field.accessibilityLabel = "Claim code"
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        field.delegate = context.coordinator
        field.text = text
        return field
    }

    func updateUIView(_ field: UITextField, context: Context) {
        context.coordinator.text = $text
        // The model cleared the code (after the API answered).
        if field.text != text { field.text = text }
    }

    func makeCoordinator() -> Coordinator { Coordinator(text: $text) }

    final class Coordinator: NSObject, UITextFieldDelegate {
        var text: Binding<String>

        init(text: Binding<String>) { self.text = text }

        func textField(
            _ field: UITextField,
            shouldChangeCharactersIn range: NSRange,
            replacementString string: String
        ) -> Bool {
            let current = field.text ?? ""
            guard let replaced = Range(range, in: current) else { return false }
            let raw = current.replacingCharacters(in: replaced, with: string)
            let caret = current[..<replaced.lowerBound].count + string.count
            let (value, cursor) = ClaimCode.format(raw, cursor: caret)
            field.text = value
            let offset = value.index(value.startIndex, offsetBy: min(cursor, value.count)).utf16Offset(in: value)
            if let position = field.position(from: field.beginningOfDocument, offset: offset) {
                field.selectedTextRange = field.textRange(from: position, to: position)
            }
            text.wrappedValue = value
            return false
        }
    }
}
