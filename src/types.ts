export type Side = "buy" | "sell";

export interface RiskSnapshot {
  equity?: number | null;
  unrealized_pnl?: number | null;
  available_balance?: number | null;
  gross_exposure?: number | null;
  daily_loss_floor?: number | null;
  max_loss_floor?: number | null;
  daily_loss_room?: number | null;
  max_loss_room?: number | null;
  remaining_profit_target?: number | null;
  marks_complete?: boolean;
  [key: string]: unknown;
}

export interface ChallengeAccount {
  id: string;
  name?: string;
  status?: string;
  stage?: string;
  balance?: number;
  starting_balance?: number;
  risk?: RiskSnapshot;
  risk_snapshot?: RiskSnapshot;
  [key: string]: unknown;
}

export interface Market {
  id: string;
  market_id?: string;
  symbol?: string;
  available?: boolean;
  size_precision?: number;
  quantity_precision?: number;
  [key: string]: unknown;
}

export interface Quote {
  bid: number;
  ask: number;
  mid: number;
  fillable?: boolean;
  estimated_fill_price?: number;
  estimated_notional?: number;
  estimated_fee?: number;
  [key: string]: unknown;
}

export interface TradingPolicy {
  manual_trading_blocked?: boolean;
  opening_exposure_restricted?: boolean;
  payout_pending?: boolean;
  copy_follower_locked?: boolean;
  copy_scope_blocked?: boolean;
  trading_halt?: { platform?: boolean; categories?: string[] };
  restriction?: { restriction?: string; reason?: string } | null;
  limits?: {
    max_position_value_usd?: number;
    min_order_notional_usd?: number;
    max_open_positions?: number;
    trades_per_day?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface TradeTicket {
  id: string;
  userId: number;
  accountId: string;
  marketId: string;
  symbol: string;
  side: Side;
  riskUsd: number;
  size: number;
  expectedPrice: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  estimatedNotional: number;
  estimatedFee?: number;
  leverage: number;
  expiresAt: number;
}
