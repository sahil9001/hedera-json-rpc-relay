/*-
 *
 * Hedera JSON RPC Relay
 *
 * Copyright (C) 2022-2024 Hedera Hashgraph, LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

import pino from 'pino';
import path from 'path';
import dotenv from 'dotenv';
import { expect } from 'chai';
import EventEmitter from 'events';
import { Registry } from 'prom-client';
import { Client } from '@hashgraph/sdk';
import { SDKClient } from '../../src/lib/clients';
import HbarLimit from '../../src/lib/hbarlimiter';
import HAPIService from '../../src/lib/services/hapiService/hapiService';
import { CacheService } from '../../src/lib/services/cacheService/cacheService';
import { RequestDetails } from '../../src/lib/types';
import { overrideEnvsInMochaDescribe, withOverriddenEnvsInMochaTest } from '../helpers';

dotenv.config({ path: path.resolve(__dirname, '../test.env') });

const registry = new Registry();
const logger = pino();

describe('HAPI Service', async function () {
  this.timeout(20000);
  let hbarLimiter: HbarLimit;
  let cacheService: CacheService;
  let eventEmitter: EventEmitter;
  let hapiService: HAPIService;

  const errorStatus = 50;
  const requestDetails = new RequestDetails({ requestId: 'hapiService.spec.ts', ipAddress: '0.0.0.0' });

  this.beforeAll(() => {
    const duration: number = 60000;
    const total: number = 100000000;
    eventEmitter = new EventEmitter();
    cacheService = new CacheService(logger.child({ name: `cache` }), registry);
    hbarLimiter = new HbarLimit(logger.child({ name: 'hbar-rate-limit' }), Date.now(), total, duration, registry);
  });

  overrideEnvsInMochaDescribe({
    HAPI_CLIENT_TRANSACTION_RESET: '0',
    HAPI_CLIENT_DURATION_RESET: '0',
    HAPI_CLIENT_ERROR_RESET: '[50]',
  });

  it('should be able to initialize SDK instance', async function () {
    hapiService = new HAPIService(logger, registry, hbarLimiter, cacheService, eventEmitter);
    const client = hapiService.getMainClientInstance();
    const sdkClient = hapiService.getSDKClient();

    expect(client).to.be.instanceof(Client);
    expect(sdkClient).to.be.instanceof(SDKClient);
  });

  withOverriddenEnvsInMochaTest({ HAPI_CLIENT_TRANSACTION_RESET: '2' }, () => {
    it('should be able to reinitialise SDK instance upon reaching transaction limit', async function () {
      hapiService = new HAPIService(logger, registry, hbarLimiter, cacheService, eventEmitter);
      expect(hapiService.getTransactionCount()).to.eq(parseInt(process.env.HAPI_CLIENT_TRANSACTION_RESET!));

      const oldClientInstance = hapiService.getMainClientInstance();
      let oldSDKInstance = hapiService.getSDKClient(); // decrease transaction limit by taking the instance
      oldSDKInstance = hapiService.getSDKClient(); // decrease transaction limit by taking the instance
      expect(hapiService.getTransactionCount()).to.eq(0);
      const newSDKInstance = hapiService.getSDKClient();
      const newClientInstance = hapiService.getMainClientInstance();

      expect(oldSDKInstance).to.not.be.equal(newSDKInstance);
      expect(oldClientInstance).to.not.be.equal(newClientInstance);
      expect(hapiService.getTransactionCount()).to.eq(parseInt(process.env.HAPI_CLIENT_TRANSACTION_RESET!) - 1); // one less because we took the instance once and decreased the counter
    });
  });

  withOverriddenEnvsInMochaTest({ HAPI_CLIENT_DURATION_RESET: '100' }, () => {
    it('should be able to reinitialise SDK instance upon reaching time limit', async function () {
      hapiService = new HAPIService(logger, registry, hbarLimiter, cacheService, eventEmitter);
      expect(hapiService.getTimeUntilReset()).to.eq(parseInt(process.env.HAPI_CLIENT_DURATION_RESET!));

      const oldClientInstance = hapiService.getMainClientInstance();
      await new Promise((r) => setTimeout(r, 200)); // await to reach time limit
      const oldSDKInstance = hapiService.getSDKClient();
      const newSDKInstance = hapiService.getSDKClient();
      const newClientInstance = hapiService.getMainClientInstance();

      expect(hapiService.getTimeUntilReset()).to.eq(parseInt(process.env.HAPI_CLIENT_DURATION_RESET!));
      expect(oldSDKInstance).to.not.be.equal(newSDKInstance);
      expect(oldClientInstance).to.not.be.equal(newClientInstance);
    });
  });

  withOverriddenEnvsInMochaTest({ HAPI_CLIENT_ERROR_RESET: '[50]' }, () => {
    it('should be able to reinitialise SDK instance upon error status code encounter', async function () {
      hapiService = new HAPIService(logger, registry, hbarLimiter, cacheService, eventEmitter);
      expect(hapiService.getErrorCodes()[0]).to.eq(JSON.parse(process.env.HAPI_CLIENT_ERROR_RESET!)[0]);

      const oldClientInstance = hapiService.getMainClientInstance();
      const oldSDKInstance = hapiService.getSDKClient();
      hapiService.decrementErrorCounter(errorStatus);
      const newSDKInstance = hapiService.getSDKClient();
      const newClientInstance = hapiService.getMainClientInstance();

      expect(oldSDKInstance).to.not.be.equal(newSDKInstance);
      expect(oldClientInstance).to.not.be.equal(newClientInstance);
      expect(hapiService.getErrorCodes()[0]).to.eq(JSON.parse(process.env.HAPI_CLIENT_ERROR_RESET!)[0]);
    });
  });

  withOverriddenEnvsInMochaTest(
    {
      HAPI_CLIENT_ERROR_RESET: '[50]',
      HAPI_CLIENT_TRANSACTION_RESET: '50',
      HAPI_CLIENT_DURATION_RESET: '36000',
    },
    () => {
      it('should be able to reset all counter upon reinitialization of the SDK Client', async function () {
        hapiService = new HAPIService(logger, registry, hbarLimiter, cacheService, eventEmitter);

        expect(hapiService.getErrorCodes()[0]).to.eq(JSON.parse(process.env.HAPI_CLIENT_ERROR_RESET!)[0]);
        const oldClientInstance = hapiService.getMainClientInstance();
        const oldSDKInstance = hapiService.getSDKClient();
        hapiService.decrementErrorCounter(errorStatus);
        const newSDKInstance = hapiService.getSDKClient();
        const newClientInstance = hapiService.getMainClientInstance();

        expect(hapiService.getTimeUntilReset()).to.eq(parseInt(process.env.HAPI_CLIENT_DURATION_RESET!));
        expect(hapiService.getErrorCodes()[0]).to.eq(JSON.parse(process.env.HAPI_CLIENT_ERROR_RESET!)[0]);
        expect(hapiService.getTransactionCount()).to.eq(parseInt(process.env.HAPI_CLIENT_TRANSACTION_RESET!) - 1); // one less because we took the instance once and decreased the counter
        expect(oldSDKInstance).to.not.be.equal(newSDKInstance);
        expect(oldClientInstance).to.not.be.equal(newClientInstance);
      });
    },
  );

  withOverriddenEnvsInMochaTest(
    {
      HAPI_CLIENT_ERROR_RESET: '[50]',
      HAPI_CLIENT_TRANSACTION_RESET: '50',
      HAPI_CLIENT_DURATION_RESET: '36000',
    },
    () => {
      it('should keep the same instance of hbar limiter and not reset the budget', async function () {
        const costAmount = 10000;
        hapiService = new HAPIService(logger, registry, hbarLimiter, cacheService, eventEmitter);

        const hbarLimiterBudgetBefore = hbarLimiter.getRemainingBudget();
        const oldClientInstance = hapiService.getMainClientInstance();
        const oldSDKInstance = hapiService.getSDKClient();

        hbarLimiter.addExpense(costAmount, Date.now(), requestDetails);
        hapiService.decrementErrorCounter(errorStatus);

        const newSDKInstance = hapiService.getSDKClient();
        const newClientInstance = hapiService.getMainClientInstance();
        const hbarLimiterBudgetAfter = hbarLimiter.getRemainingBudget();

        expect(hbarLimiterBudgetBefore).to.be.greaterThan(hbarLimiterBudgetAfter);
        expect(oldSDKInstance).to.not.be.equal(newSDKInstance);
        expect(oldClientInstance).to.not.be.equal(newClientInstance);
      });
    },
  );

  withOverriddenEnvsInMochaTest(
    {
      HAPI_CLIENT_TRANSACTION_RESET: '0',
      HAPI_CLIENT_DURATION_RESET: '0',
      HAPI_CLIENT_ERROR_RESET: '[]',
    },
    () => {
      it('should not be able to reinitialise and decrement counters, if it is disabled', async function () {
        hapiService = new HAPIService(logger, registry, hbarLimiter, cacheService, eventEmitter);
        expect(hapiService.getTransactionCount()).to.eq(parseInt(process.env.HAPI_CLIENT_TRANSACTION_RESET!));

        const oldClientInstance = hapiService.getMainClientInstance();
        const oldSDKInstance = hapiService.getSDKClient();
        const newSDKInstance = hapiService.getSDKClient();
        const newClientInstance = hapiService.getMainClientInstance();

        expect(oldSDKInstance).to.be.equal(newSDKInstance);
        expect(oldClientInstance).to.be.equal(newClientInstance);
        expect(hapiService.getIsReinitEnabled()).to.be.equal(false);
      });
    },
  );
});
