// Trading 212 API Client
// Wraps the T212 beta API with typed methods
//
// Base URL: https://demo.trading212.com/api/v0 (practice) or https://live.trading212.com/api/v0 (live)
// Auth: Authorization header with API key
//
// IMPORTANT LIMITATIONS (T212 API does NOT support):
//   - Historical OHLC/candle data → use Twelve Data instead
//   - SL/TP on order placement → must monitor and manage ourselves
//   - Trailing stops → must implement in scheduler
//   - Position labels/tags → track in local DB
//   - Close position endpoint → place opposite order for same quantity
//   - Modify position → must manage via separate orders

import axios, { type AxiosInstance } from 'axios';
import type { T212Position, T212Balance, T212Instrument } from '../types.js';

export class T212Client {
  private client: AxiosInstance;

  constructor(apiKey: string, mode: 'demo' | 'live' = 'demo') {
    const baseURL = mode === 'live'
      ? 'https://live.trading212.com/api/v0'
      : 'https://demo.trading212.com/api/v0';

    this.client = axios.create({
      baseURL,
      headers: { Authorization: apiKey },
      timeout: 10000,
    });
  }

  // ==================== ACCOUNT ====================

  async getPortfolio(): Promise<T212Position[]> {
    const { data } = await this.client.get<T212Position[]>('/equity/portfolio');
    return data;
  }

  async getBalance(): Promise<T212Balance> {
    const { data } = await this.client.get<T212Balance>('/equity/account/cash');
    return data;
  }

  // ==================== INSTRUMENTS ====================

  async getInstruments(): Promise<T212Instrument[]> {
    const { data } = await this.client.get<T212Instrument[]>('/equity/metadata/instruments');
    return data;
  }

  // ==================== ORDERS ====================

  async placeMarketOrder(ticker: string, quantity: number): Promise<unknown> {
    const { data } = await this.client.post('/equity/orders/market', {
      ticker,
      quantity,
    });
    return data;
  }

  async placeLimitOrder(
    ticker: string,
    quantity: number,
    limitPrice: number,
    timeValidity: 'DAY' | 'GTC' = 'GTC'
  ): Promise<unknown> {
    const { data } = await this.client.post('/equity/orders/limit', {
      ticker,
      quantity,
      limitPrice,
      timeValidity,
    });
    return data;
  }

  async placeStopOrder(
    ticker: string,
    quantity: number,
    stopPrice: number,
    timeValidity: 'DAY' | 'GTC' = 'GTC'
  ): Promise<unknown> {
    const { data } = await this.client.post('/equity/orders/stop', {
      ticker,
      quantity,
      stopPrice,
      timeValidity,
    });
    return data;
  }

  // ==================== POSITION MANAGEMENT ====================
  // T212 has no "close" or "modify" endpoints.
  // Close = place opposite order for same quantity.
  // SL/TP = place stop/limit orders and track in DB.

  async closePosition(ticker: string, currentQuantity: number): Promise<unknown> {
    // Close by selling the held quantity (or buying back for shorts)
    // Negative quantity = sell, positive = buy
    return this.placeMarketOrder(ticker, -currentQuantity);
  }

  async partialClose(ticker: string, units: number): Promise<unknown> {
    return this.placeMarketOrder(ticker, -units);
  }
}
