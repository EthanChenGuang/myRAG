module.exports = {
	'roots': [
		'<rootDir>/src'
	],
	'testMatch': [
		'**/Tests/test.*.+(ts|tsx|js)',
	],
	'transform': {
		'^.+\\.(ts|tsx)$': ['ts-jest', { tsconfig: { verbatimModuleSyntax: false, module: 'commonjs' } }]
	},
	moduleNameMapper: {
		'^axios$': require.resolve('axios'),
	},
}
