// Intentionally empty. SwiftPM refuses a target with no Swift sources before
// build plugins run, and the GenerateAPI plugin (OpenAPITooling) emits
// Types*.swift and Client.swift into the build directory, not here. The only
// input is openapi.json in this directory, a symlink to apps/api/openapi.json.
