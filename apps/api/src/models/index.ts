import { UserModel, SessionModel, AuthTokenModel } from './account.js';
import { DeviceModel } from './device.js';
import { ProductModel } from './product.js';
import { ProviderBudgetModel } from './providerBudget.js';
import { TrackedItemModel, PriceHistoryModel, NotificationDeliveryModel } from './tracking.js';

/** Explicit additive index creation; never drops indexes or data. Run before accepting traffic. */
export async function createDatabaseIndexes(): Promise<void> {
  for (const model of [UserModel, SessionModel, AuthTokenModel, DeviceModel, ProductModel,
    ProviderBudgetModel, TrackedItemModel, PriceHistoryModel, NotificationDeliveryModel]) {
    await model.createIndexes();
  }
}
