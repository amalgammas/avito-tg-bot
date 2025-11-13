import type { Config } from 'jest';

const config: Config = {
  verbose: false,
  testEnvironment: 'node',
  moduleFileExtensions: ['js', 'json', 'ts'],
  testMatch: ['**/?(*.)+(spec|test).ts'],
  transform: {
    '^.+\\.(t|j)s$': [
      'ts-jest',
      {
        tsconfig: 'tsconfig.json',
      },
    ],
  },
  moduleNameMapper: {
    '^@bot/(.*)$': '<rootDir>/apps/bot-api/src/$1',
  },
  rootDir: '.',
};

export default config;
