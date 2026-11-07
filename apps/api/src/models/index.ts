import { UserModel, SessionModel, AuthTokenModel, PreloginModel, AuthLimitModel } from './account.js';
import { DeviceModel } from './device.js';
import { VerificationMailModel } from './verificationMail.js';
import { ProductModel } from './product.js';
import { ProviderBudgetModel } from './providerBudget.js';
import { TrackedItemModel, PriceHistoryModel, NotificationDeliveryModel } from './tracking.js';
import { PriceCheckModel } from './priceCheck.js';
import { CheckControlModel } from './checkControl.js';

/** Explicit additive index creation; never drops indexes or data. Run before accepting traffic. */
export async function createDatabaseIndexes(): Promise<void> {
  for (const model of [UserModel, SessionModel, AuthTokenModel, PreloginModel, AuthLimitModel, VerificationMailModel, DeviceModel, ProductModel,
    ProviderBudgetModel, TrackedItemModel, PriceHistoryModel, NotificationDeliveryModel, PriceCheckModel, CheckControlModel]) {
    await model.createIndexes();
  }
}
