export type SteamGame = {
    appId: number;
    name: string;
    imageUrl: string;
    originalPrice: number;
    currentPrice: number;
    discountPercent: number;
    currency: string;
};