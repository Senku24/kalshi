import { Schema, model, models } from "mongoose";

// ─── User ──────────────────────────────────────────────

const userSchema = new Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      minlength: 3,
      maxlength: 30,
      trim: true,
      lowercase: true,
    },
    passwordHash: {
      type: String,
      required: true,
      select: false,
    },
    balance: {
      type: Number,
      required: true,
      default: 10_000,
      min: 0,
      validate: Number.isSafeInteger,
    },
    role: {
      type: String,
      enum: ["user", "admin"],
      default: "user",
      required: true,
    },
  },
  { timestamps: true, versionKey: false },
);

// ─── Market ────────────────────────────────────────────

const marketSchema = new Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      minlength: 5,
      maxlength: 200,
    },
    description: {
      type: String,
      default: "",
      maxlength: 5000,
    },
    creatorId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    initialWager: {
      type: Number,
      required: true,
      min: 1,
      validate: Number.isSafeInteger,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },
    side: {
      type: String,
      enum: ["yes", "no"],
      required: true,
    },
    matchedAmount: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: Number.isSafeInteger,
    },
    status: {
      type: String,
      enum: ["open", "closed", "resolved", "cancelled"],
      required: true,
      default: "open",
    },
    resolution: {
      type: String,
      enum: ["yes", "no"],
    },
    resolvedAt: Date,
  },
  { timestamps: true, versionKey: false },
);

marketSchema.index({ status: 1, expiresAt: 1 });

// ─── Bet ───────────────────────────────────────────────

const betSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    marketId: {
      type: Schema.Types.ObjectId,
      ref: "Market",
      required: true,
      index: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 1,
      validate: Number.isSafeInteger,
    },
    outcome: {
      type: String,
      enum: ["yes", "no"],
      required: true,
    },
    status: {
      type: String,
      enum: ["open", "won", "lost", "refunded"],
      default: "open",
      required: true,
    },
    payout: {
      type: Number,
      default: 0,
      min: 0,
      validate: Number.isSafeInteger,
    },
  },
  { timestamps: true, versionKey: false },
);

betSchema.index({ userId: 1, createdAt: -1 });
betSchema.index({ marketId: 1, outcome: 1 });

// ─── Wallet events ─────────────────────────────────────

const walletSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: [
        "initial_credit",
        "deposit",
        "withdrawal",
        "bet_placed",
        "payout",
        "refund",
      ],
      required: true,
    },
    // Positive = credit; negative = debit.
    amount: {
      type: Number,
      required: true,
      validate: Number.isSafeInteger,
    },
    externalId: {
      type: String,
    },
    betId: {
      type: Schema.Types.ObjectId,
      ref: "Bet",
    },
    marketId: {
      type: Schema.Types.ObjectId,
      ref: "Market",
    },
  },
  { timestamps: true, versionKey: false },
);

walletSchema.index({ userId: 1, createdAt: -1 });

walletSchema.index(
  { externalId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      externalId: { $type: "string" },
    },
  },
);

// ─── Model exports ─────────────────────────────────────

export const User =
  models.User ?? model("User", userSchema);

export const Market =
  models.Market ?? model("Market", marketSchema);

export const Bet =
  models.Bet ?? model("Bet", betSchema);

export const WalletEvent =
  models.WalletEvent ??
  model("WalletEvent", walletSchema, "walletEvents");