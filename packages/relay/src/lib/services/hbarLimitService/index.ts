/*
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

import { Logger } from 'pino';
import { Counter, Gauge, Registry } from 'prom-client';
import { IHbarLimitService } from './IHbarLimitService';
import { SubscriptionTier } from '../../db/types/hbarLimiter/subscriptionTier';
import { IDetailedHbarSpendingPlan } from '../../db/types/hbarLimiter/hbarSpendingPlan';
import { HbarSpendingPlanRepository } from '../../db/repositories/hbarLimiter/hbarSpendingPlanRepository';
import { EthAddressHbarSpendingPlanRepository } from '../../db/repositories/hbarLimiter/ethAddressHbarSpendingPlanRepository';
import { IPAddressHbarSpendingPlanRepository } from '../../db/repositories/hbarLimiter/ipAddressHbarSpendingPlanRepository';
import { RequestDetails } from '../../types';
import constants from '../../constants';
import { Hbar } from '@hashgraph/sdk';

export class HbarLimitService implements IHbarLimitService {
  static readonly TIER_LIMITS: Record<SubscriptionTier, Hbar> = {
    BASIC: Hbar.fromTinybars(constants.HBAR_RATE_LIMIT_BASIC),
    EXTENDED: Hbar.fromTinybars(constants.HBAR_RATE_LIMIT_EXTENDED),
    PRIVILEGED: Hbar.fromTinybars(constants.HBAR_RATE_LIMIT_PRIVILEGED),
  };

  /**
   * Counts the number of times the rate limit has been reached.
   * @private
   */
  private readonly hbarLimitCounter: Counter;

  /**
   * Tracks the remaining budget for the rate limiter.
   * @private
   */
  private readonly hbarLimitRemainingGauge: Gauge;

  /**
   * Tracks the number of unique spending plans that have been utilized during the limit duration.
   * (i.e., plans that had expenses added to them).
   *
   * For basic spending plans, this equates to the number of unique users who have made requests during that period,
   * since each user has their own individual spending plan.
   *
   * @private
   */
  private readonly uniqueSpendingPlansCounter: Record<SubscriptionTier, Counter>;

  /**
   * Tracks the average amount of tinybars spent by spending plans per subscription tier
   * @private
   */
  private readonly averageSpendingPlanAmountSpentGauge: Record<SubscriptionTier, Gauge>;

  /**
   * The remaining budget for the rate limiter.
   * @private
   */
  private remainingBudget: Hbar;

  /**
   * The reset timestamp for the rate limiter.
   * @private
   */
  private reset: Date;

  constructor(
    private readonly hbarSpendingPlanRepository: HbarSpendingPlanRepository,
    private readonly ethAddressHbarSpendingPlanRepository: EthAddressHbarSpendingPlanRepository,
    private readonly ipAddressHbarSpendingPlanRepository: IPAddressHbarSpendingPlanRepository,
    private readonly logger: Logger,
    private readonly register: Registry,
    private readonly totalBudget: Hbar,
    private readonly limitDuration: number,
  ) {
    this.reset = this.getResetTimestamp();
    this.remainingBudget = this.totalBudget;

    const metricCounterName = 'rpc_relay_hbar_rate_limit';
    this.register.removeSingleMetric(metricCounterName);
    this.hbarLimitCounter = new Counter({
      name: metricCounterName,
      help: 'Relay Hbar limit counter',
      registers: [register],
      labelNames: ['mode', 'methodName'],
    });
    this.hbarLimitCounter.inc(0);

    const rateLimiterRemainingGaugeName = 'rpc_relay_hbar_rate_remaining';
    this.register.removeSingleMetric(rateLimiterRemainingGaugeName);
    this.hbarLimitRemainingGauge = new Gauge({
      name: rateLimiterRemainingGaugeName,
      help: 'Relay Hbar rate limit remaining budget',
      registers: [register],
    });
    this.hbarLimitRemainingGauge.set(this.remainingBudget.toTinybars().toNumber());

    this.uniqueSpendingPlansCounter = Object.values(SubscriptionTier).reduce(
      (acc, tier) => {
        const uniqueSpendingPlansCounterName = `unique_spending_plans_counter_${tier.toLowerCase()}`;
        this.register.removeSingleMetric(uniqueSpendingPlansCounterName);
        acc[tier] = new Counter({
          name: uniqueSpendingPlansCounterName,
          help: `Tracks the number of unique ${tier} spending plans used during the limit duration`,
          registers: [register],
        });
        return acc;
      },
      {} as Record<SubscriptionTier, Counter>,
    );

    this.averageSpendingPlanAmountSpentGauge = Object.values(SubscriptionTier).reduce(
      (acc, tier) => {
        const averageAmountSpentGaugeName = `average_spending_plan_amount_spent_gauge_${tier.toLowerCase()}`;
        this.register.removeSingleMetric(averageAmountSpentGaugeName);
        acc[tier] = new Gauge({
          name: averageAmountSpentGaugeName,
          help: `Tracks the average amount of tinybars spent by ${tier} spending plans`,
          registers: [register],
        });
        return acc;
      },
      {} as Record<SubscriptionTier, Gauge>,
    );
  }

  /**
   * Resets the {@link HbarSpendingPlan#amountSpent} field for all existing plans.
   * @param {RequestDetails} requestDetails - The request details used for logging and tracking.
   * @returns {Promise<void>} - A promise that resolves when the operation is complete.
   */
  async resetLimiter(requestDetails: RequestDetails): Promise<void> {
    this.logger.trace(`${requestDetails.formattedRequestId} Resetting HBAR rate limiter...`);
    await this.hbarSpendingPlanRepository.resetAmountSpentOfAllPlans(requestDetails);
    this.resetBudget();
    this.resetTemporaryMetrics();
    this.reset = this.getResetTimestamp();
    this.logger.trace(
      `${requestDetails.formattedRequestId} HBAR Rate Limit reset: remainingBudget=${this.remainingBudget}, newResetTimestamp=${this.reset}`,
    );
  }

  /**
   * Checks if the given eth address or ip address should be limited.
   * @param {string} mode - The mode of the transaction or request.
   * @param {string} methodName - The name of the method being invoked.
   * @param {string} ethAddress - The eth address to check.
   * @param {RequestDetails} requestDetails The request details for logging and tracking.
   * @param {number} [estimatedTxFee] - The total estimated transaction fee, default to 0.
   * @returns {Promise<boolean>} - A promise that resolves with a boolean indicating if the address should be limited.
   */
  async shouldLimit(
    mode: string,
    methodName: string,
    ethAddress: string,
    requestDetails: RequestDetails,
    estimatedTxFee: number = 0,
  ): Promise<boolean> {
    const ipAddress = requestDetails.ipAddress;
    if (await this.isTotalBudgetExceeded(mode, methodName, estimatedTxFee, requestDetails)) {
      return true;
    }
    if (!ethAddress && !ipAddress) {
      this.logger.warn('No eth address or ip address provided, cannot check if address should be limited');
      return false;
    }
    const user = `(ethAddress=${ethAddress})`;
    this.logger.trace(`${requestDetails.formattedRequestId} Checking if ${user} should be limited...`);
    let spendingPlan = await this.getSpendingPlan(ethAddress, requestDetails);
    if (!spendingPlan) {
      // Create a basic spending plan if none exists for the eth address or ip address
      spendingPlan = await this.createBasicSpendingPlan(ethAddress, requestDetails);
    }

    const spendingLimit = HbarLimitService.TIER_LIMITS[spendingPlan.subscriptionTier].toTinybars();

    const exceedsLimit =
      spendingLimit.lte(spendingPlan.amountSpent) || spendingLimit.lt(spendingPlan.amountSpent + estimatedTxFee);
    this.logger.trace(
      `${requestDetails.formattedRequestId} ${user} ${exceedsLimit ? 'should' : 'should not'} be limited: amountSpent=${
        spendingPlan.amountSpent
      }, estimatedTxFee=${estimatedTxFee} tℏ, spendingLimit=${spendingLimit.toString()} tℏ`,
    );
    return exceedsLimit;
  }

  /**
   * Add expense to the remaining budget.
   * @param {number} cost - The cost of the expense.
   * @param {string} ethAddress - The Ethereum address to add the expense to.
   * @param {RequestDetails} requestDetails The request details for logging and tracking.
   * @returns {Promise<void>} - A promise that resolves when the expense has been added.
   */
  async addExpense(cost: number, ethAddress: string, requestDetails: RequestDetails): Promise<void> {
    const ipAddress = requestDetails.ipAddress;
    if (!ethAddress && !ipAddress) {
      throw new Error('Cannot add expense without an eth address or ip address');
    }

    let spendingPlan = await this.getSpendingPlan(ethAddress, requestDetails);
    if (!spendingPlan) {
      // Create a basic spending plan if none exists for the eth address or ip address
      spendingPlan = await this.createBasicSpendingPlan(ethAddress, requestDetails);
    }

    this.logger.trace(
      `${requestDetails.formattedRequestId} Adding expense of ${cost} to spending plan with ID ${
        spendingPlan.id
      }, new amountSpent=${spendingPlan.amountSpent + cost}`,
    );

    // Check if the spending plan is being used for the first time today
    if (spendingPlan.amountSpent === 0) {
      this.uniqueSpendingPlansCounter[spendingPlan.subscriptionTier].inc(1);
    }

    await this.hbarSpendingPlanRepository.addToAmountSpent(spendingPlan.id, cost, requestDetails, this.limitDuration);
    this.remainingBudget = Hbar.fromTinybars(this.remainingBudget.toTinybars().sub(cost));
    this.hbarLimitRemainingGauge.set(this.remainingBudget.toTinybars().toNumber());

    // Done asynchronously in the background
    this.updateAverageAmountSpentPerSubscriptionTier(spendingPlan.subscriptionTier, requestDetails).then();

    this.logger.trace(
      `${requestDetails.formattedRequestId} HBAR rate limit expense update: cost=${cost} tℏ, remainingBudget=${this.remainingBudget}`,
    );
  }

  /**
   * Checks if the total budget of the limiter has been exceeded.
   * @param {string} mode - The mode of the transaction or request.
   * @param {string} methodName - The name of the method being invoked.
   * @param {number} estimatedTxFee - The total estimated transaction fee, default to 0.
   * @param {RequestDetails} requestDetails The request details for logging and tracking
   * @returns {Promise<boolean>} - Resolves `true` if the total budget has been exceeded, otherwise `false`.
   * @private
   */
  private async isTotalBudgetExceeded(
    mode: string,
    methodName: string,
    estimatedTxFee: number = 0,
    requestDetails: RequestDetails,
  ): Promise<boolean> {
    if (this.shouldResetLimiter()) {
      await this.resetLimiter(requestDetails);
    }
    if (this.remainingBudget.toTinybars().lte(0) || this.remainingBudget.toTinybars().sub(estimatedTxFee).lt(0)) {
      this.hbarLimitCounter.labels(mode, methodName).inc(1);
      this.logger.warn(
        `${requestDetails.formattedRequestId} HBAR rate limit incoming call: remainingBudget=${this.remainingBudget}, totalBudget=${this.totalBudget}, estimatedTxFee=${estimatedTxFee} tℏ, resetTimestamp=${this.reset}`,
      );
      return true;
    } else {
      this.logger.trace(
        `${requestDetails.formattedRequestId} HBAR rate limit not reached: remainingBudget=${this.remainingBudget}, totalBudget=${this.totalBudget}, estimatedTxFee=${estimatedTxFee} tℏ, resetTimestamp=${this.reset}.`,
      );
      return false;
    }
  }

  /**
   * Updates the average amount of tinybars spent of spending plans per subscription tier.
   * @param {SubscriptionTier} subscriptionTier - The subscription tier to update the average usage for.
   * @param {RequestDetails} requestDetails - The request details for logging and tracking.
   * @private {Promise<void>} - A promise that resolves when the average usage has been updated.
   */
  private async updateAverageAmountSpentPerSubscriptionTier(
    subscriptionTier: SubscriptionTier,
    requestDetails: RequestDetails,
  ): Promise<void> {
    const plans = await this.hbarSpendingPlanRepository.findAllActiveBySubscriptionTier(
      [subscriptionTier],
      requestDetails,
    );
    const totalUsage = plans.reduce((total, plan) => total + plan.amountSpent, 0);
    const averageUsage = Math.round(totalUsage / plans.length);
    this.averageSpendingPlanAmountSpentGauge[subscriptionTier].set(averageUsage);
  }

  /**
   * Checks if the rate limiter should be reset.
   * @returns {boolean} - `true` if the rate limiter should be reset, otherwise `false`.
   * @private
   */
  private shouldResetLimiter(): boolean {
    return Date.now() >= this.reset.getTime();
  }

  /**
   * Resets the remaining budget to the total budget.
   * @private
   */
  private resetBudget(): void {
    this.remainingBudget = this.totalBudget;
    this.hbarLimitRemainingGauge.set(this.remainingBudget.toTinybars().toNumber());
  }

  /**
   * Resets the metrics which are used to track the number of unique spending plans used during the limit duration.
   * @private
   */
  private resetTemporaryMetrics(): void {
    Object.values(SubscriptionTier).forEach((tier) => this.uniqueSpendingPlansCounter[tier].reset());
  }

  /**
   * Calculates the next reset timestamp for the rate limiter.
   *
   * This method determines the next reset timestamp based on the current reset timestamp
   * and the limit duration. If the current reset timestamp is not defined, it initializes
   * the reset timestamp to midnight of the current day. It then iteratively adds the limit
   * duration to the reset timestamp until it is in the future.
   *
   * @returns {Date} - The next reset timestamp.
   */
  private getResetTimestamp(): Date {
    const todayAtMidnight = new Date().setHours(0, 0, 0, 0);

    let resetDate = this.reset ? new Date(this.reset.getTime()) : new Date(todayAtMidnight);
    while (resetDate.getTime() < Date.now()) {
      // 1. Calculate the difference between the current time and the reset time.
      // 2. Determine how many intervals of size `limitDuration` have passed since the last reset.
      // 3. Calculate the new reset date by adding the required intervals to the original reset date.
      const intervalsPassed = Math.ceil((Date.now() - resetDate.getTime()) / this.limitDuration);
      resetDate = new Date(resetDate.getTime() + intervalsPassed * this.limitDuration);
    }

    return resetDate;
  }

  /**
   * Gets the spending plan for the given eth address or ip address.
   * @param {string} ethAddress - The eth address to get the spending plan for.
   * @param {RequestDetails} requestDetails - The request details for logging and tracking.
   * @returns {Promise<IDetailedHbarSpendingPlan | null>} - A promise that resolves with the spending plan or null if none exists.
   * @private
   */
  private async getSpendingPlan(
    ethAddress: string,
    requestDetails: RequestDetails,
  ): Promise<IDetailedHbarSpendingPlan | null> {
    const ipAddress = requestDetails.ipAddress;
    if (ethAddress) {
      try {
        return await this.getSpendingPlanByEthAddress(ethAddress, requestDetails);
      } catch (error) {
        this.logger.warn(
          error,
          `${requestDetails.formattedRequestId} Failed to get spending plan for eth address '${ethAddress}'`,
        );
      }
    }
    if (ipAddress) {
      try {
        return await this.getSpendingPlanByIPAddress(requestDetails);
      } catch (error) {
        this.logger.warn(error, `${requestDetails.formattedRequestId} Failed to get spending plan`);
      }
    }
    return null;
  }

  /**
   * Gets the spending plan for the given eth address.
   * @param {string} ethAddress - The eth address to get the spending plan for.
   * @param {RequestDetails} requestDetails - The request details for logging and tracking.
   * @returns {Promise<IDetailedHbarSpendingPlan>} - A promise that resolves with the spending plan.
   * @private
   */
  private async getSpendingPlanByEthAddress(
    ethAddress: string,
    requestDetails: RequestDetails,
  ): Promise<IDetailedHbarSpendingPlan> {
    const ethAddressHbarSpendingPlan = await this.ethAddressHbarSpendingPlanRepository.findByAddress(
      ethAddress,
      requestDetails,
    );
    return this.hbarSpendingPlanRepository.findByIdWithDetails(ethAddressHbarSpendingPlan.planId, requestDetails);
  }

  /**
   * Gets the spending plan for the given IP address.
   * @param {RequestDetails} requestDetails - The request details for logging and tracking.
   * @returns {Promise<IDetailedHbarSpendingPlan>} - A promise that resolves with the spending plan.
   * @private
   */
  private async getSpendingPlanByIPAddress(requestDetails: RequestDetails): Promise<IDetailedHbarSpendingPlan> {
    const ipAddress = requestDetails.ipAddress;
    const ipAddressHbarSpendingPlan = await this.ipAddressHbarSpendingPlanRepository.findByAddress(
      ipAddress,
      requestDetails,
    );
    return this.hbarSpendingPlanRepository.findByIdWithDetails(ipAddressHbarSpendingPlan.planId, requestDetails);
  }

  /**
   * Creates a basic spending plan for the given eth address.
   * @param {string} ethAddress - The eth address to create the spending plan for.
   * @param {RequestDetails} requestDetails - The request details for logging and tracking.
   * @returns {Promise<IDetailedHbarSpendingPlan>} - A promise that resolves with the created spending plan.
   * @private
   */
  private async createBasicSpendingPlan(
    ethAddress: string,
    requestDetails: RequestDetails,
  ): Promise<IDetailedHbarSpendingPlan> {
    const ipAddress = requestDetails.ipAddress;
    if (!ethAddress && !ipAddress) {
      throw new Error('Cannot create a spending plan without an associated eth address or ip address');
    }

    const spendingPlan = await this.hbarSpendingPlanRepository.create(
      SubscriptionTier.BASIC,
      requestDetails,
      this.limitDuration,
    );
    if (ethAddress) {
      this.logger.trace(
        `${requestDetails.formattedRequestId} Linking spending plan with ID ${spendingPlan.id} to eth address ${ethAddress}`,
      );
      await this.ethAddressHbarSpendingPlanRepository.save(
        { ethAddress, planId: spendingPlan.id },
        requestDetails,
        this.limitDuration,
      );
    }
    if (ipAddress) {
      this.logger.trace(
        `${requestDetails.formattedRequestId} Linking spending plan with ID ${spendingPlan.id} to ip address ${ipAddress}`,
      );
      await this.ipAddressHbarSpendingPlanRepository.save(
        { ipAddress, planId: spendingPlan.id },
        requestDetails,
        this.limitDuration,
      );
    }
    return spendingPlan;
  }
}
