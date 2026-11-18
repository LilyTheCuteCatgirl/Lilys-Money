// Strict syntax and safe correctness checks, without refactoring legacy gameplay code.
export default [
    {
        ignores: ["builds/**", "node_modules/**", "addon/rp/**"],
    },
    {
        files: ["addon/bp/scripts/**/*.js", "tools/**/*.mjs", "eslint.config.js"],
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "module",
            globals: {
                console: "readonly",
                process: "readonly",
                Buffer: "readonly",
                setTimeout: "readonly",
                clearTimeout: "readonly",
            },
        },
        rules: {
            "constructor-super": "error",
            "for-direction": "error",
            "getter-return": "error",
            "no-async-promise-executor": "error",
            "no-compare-neg-zero": "error",
            "no-constant-binary-expression": "error",
            "no-dupe-args": "error",
            "no-dupe-class-members": "error",
            "no-duplicate-case": "error",
            "no-empty-character-class": "error",
            "no-ex-assign": "error",
            "no-import-assign": "error",
            "no-invalid-regexp": "error",
            "no-promise-executor-return": "off",
            "no-sparse-arrays": "error",
            "no-unsafe-finally": "error",
            "no-unreachable": "error",
            "no-unsafe-negation": "error",
            "use-isnan": "error",
            "valid-typeof": "error",
            // Existing code contains intentionally silent catches and unused helpers.
            // Tighten these rules later in separate, reviewable cleanup commits.
            "no-empty": "off",
            "no-unused-vars": "off",
            "no-undef": "off",
        },
    },
];
