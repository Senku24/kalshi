import "dotenv/config";

import express, {
  type ErrorRequestHandler,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import cors from "cors";
import mongoose, { type ClientSession } from "mongoose";
import { z } from "zod";

import { connectDB } from "./db";
import { User, Market, Bet, WalletEvent } from "./modules/models";
import {
  authenticate,
  generateToken,
  hashPassword,
  verifyPassword,
} from "./auth";

const app = express();

const PORT = Number(process.env.PORT ?? 5000);
const API = "/api/v1";

const INITIAL_BALANCE = 10_000;
const MAX_BALANCE = Number.MAX_SAFE_INTEGER;
const MAX_AMOUNT = 1_000_000;

app.use(
  cors({
    origin: process.env.CLIENT_URL ?? "http://localhost:5173",
  }),
);

app.use(express.json({ limit: "16kb" }));

// ─── Errors and helpers ─────────────────────────────────

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const asyncHandler = (
  handler: (
    req: Request,
    res: Response,
  ) => Promise<unknown>,
): RequestHandler =>
  (req, res, next) => {
    void handler(req, res).catch(next);
  };

async function inTransaction<T>(
  operation: (session: ClientSession) => Promise<T>,
): Promise<T> {
  const session = await mongoose.startSession();

  try {
    let result!: T;

    await session.withTransaction(async () => {
      result = await operation(session);
    });

    return result;
  } finally {
    await session.endSession();
  }
}

function parseBody<T extends z.ZodType>(
  schema: T,
  body: unknown,
): z.infer<T> {
  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    throw new HttpError(
      400,
      "Invalid request body",
      parsed.error.flatten().fieldErrors,
    );
  }

  return parsed.data;
}

function getUserId(req: Request): string {
  if (!req.auth?.userId) {
    throw new HttpError(401, "Authentication required");
  }

  return req.auth.userId;
}

function roleOf(user: { role: string }): "user" | "admin" {
  return user.role === "admin" ? "admin" : "user";
}

function isDuplicateKey(error: unknown): boolean {
  return (
    error instanceof mongoose.mongo.MongoServerError &&
    error.code === 11000
  );
}

function isValidObjectId(value: string): boolean {
  return /^[a-f\d]{24}$/i.test(value);
}

// ─── Validation schemas ─────────────────────────────────

const usernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(30)
  .regex(/^[a-zA-Z0-9_]+$/)
  .transform((value) => value.toLowerCase());

const passwordSchema = z
  .string()
  .min(12)
  .max(72)
  .refine(
    (password) => new TextEncoder().encode(password).length <= 72,
    "Password must not exceed 72 UTF-8 bytes",
  );

const signupSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
});

const signinSchema = z.object({
  username: usernameSchema,
  password: z.string().min(1).max(72),
});

const amountSchema = z
  .number()
  .int()
  .positive()
  .max(MAX_AMOUNT);

const onrampSchema = z.object({
  amount: amountSchema,
});

const createMarketSchema = z.object({
  title: z.string().trim().min(5).max(200),
  description: z.string().trim().max(5000).optional(),
  expiry: z.coerce.date().refine(
    (date) => Number.isFinite(date.getTime()) &&
      date.getTime() > Date.now(),
    "Expiry must be a valid future date",
  ),
  side: z.enum(["yes", "no"]),
  initialWager: amountSchema,
});

const placeBetSchema = z.object({
  marketId: z.string().refine(isValidObjectId, "Invalid market ID"),
  amount: amountSchema,
});

const resolveSchema = z.object({
  marketId: z.string().refine(isValidObjectId, "Invalid market ID"),
  resolution: z.enum(["yes", "no"]),
});

// ─── Health check ───────────────────────────────────────

app.get(`${API}/health`, (_req, res) => {
  res.json({ status: "ok" });
});

// ─── POST /register and /api/v1/auth/signup ─────────────

app.post(
  ["/register", `${API}/auth/signup`],
  asyncHandler(async (req, res) => {
    const { username, password } = parseBody(
      signupSchema,
      req.body,
    );

    const passwordHash = await hashPassword(password);

    const user = await inTransaction(async (session) => {
      const [created] = await User.create(
        [
          {
            username,
            passwordHash,
            balance: INITIAL_BALANCE,
          },
        ],
        { session },
      );

      await WalletEvent.create(
        [
          {
            userId: created._id,
            type: "initial_credit",
            amount: INITIAL_BALANCE,
          },
        ],
        { session },
      );

      return created;
    });

    const token = generateToken({
      userId: user.id,
      role: roleOf(user),
    });

    res.status(201).json({
      message: "Account created",
      token,
      user: {
        id: user.id,
        username: user.username,
        balance: user.balance,
      },
    });
  }),
);

// ─── POST /login and /api/v1/auth/signin ────────────────

app.post(
  ["/login", `${API}/auth/signin`],
  asyncHandler(async (req, res) => {
    const { username, password } = parseBody(
      signinSchema,
      req.body,
    );

    const user = await User.findOne({ username })
      .select("+passwordHash");

    if (
      !user ||
      !(await verifyPassword(password, user.passwordHash))
    ) {
      throw new HttpError(401, "Invalid username or password");
    }

    const token = generateToken({
      userId: user.id,
      role: roleOf(user),
    });

    res.json({
      message: "Login successful",
      token,
      user: {
        id: user.id,
        username: user.username,
        balance: user.balance,
      },
    });
  }),
);

// ─── POST /onramp and /api/v1/auth/onramp ───────────────
// Development-only virtual balance top-up.

app.post(
  ["/onramp", `${API}/auth/onramp`],
  authenticate,
  asyncHandler(async (req, res) => {
    if (process.env.NODE_ENV === "production") {
      throw new HttpError(404, "Endpoint not found");
    }

    const { amount } = parseBody(onrampSchema, req.body);
    const userId = getUserId(req);

    const balance = await inTransaction(async (session) => {
      const user = await User.findOneAndUpdate(
        {
          _id: userId,
          balance: { $lte: MAX_BALANCE - amount },
        },
        { $inc: { balance: amount } },
        {
          new: true,
          session,
          runValidators: true,
        },
      );

      if (!user) {
        const exists = await User.exists({ _id: userId })
          .session(session);

        if (!exists) {
          throw new HttpError(401, "User not found");
        }

        throw new HttpError(409, "Maximum balance exceeded");
      }

      await WalletEvent.create(
        [
          {
            userId,
            type: "deposit",
            amount,
          },
        ],
        { session },
      );

      return user.balance;
    });

    res.json({
      message: "Virtual balance added",
      balance,
    });
  }),
);

// ─── GET /profile and /api/v1/auth/profile ──────────────

app.get(
  ["/profile", `${API}/auth/profile`],
  authenticate,
  asyncHandler(async (req, res) => {
    const user = await User.findById(getUserId(req));

    if (!user) {
      throw new HttpError(401, "User not found");
    }

    res.json({
      user: {
        id: user.id,
        username: user.username,
        balance: user.balance,
      },
    });
  }),
);

// ─── GET /transactions and /api/v1/auth/transactions ────

app.get(
  ["/transactions", `${API}/auth/transactions`],
  authenticate,
  asyncHandler(async (req, res) => {
    const transactions = await WalletEvent.find({
      userId: getUserId(req),
    })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    res.json({ transactions });
  }),
);

// ─── POST /market and /api/v1/market ────────────────────
// Creator's initial wager is reserved from their balance.

app.post(
  ["/market", `${API}/market`],
  authenticate,
  asyncHandler(async (req, res) => {
    const input = parseBody(createMarketSchema, req.body);
    const userId = getUserId(req);

    const market = await inTransaction(async (session) => {
      const user = await User.updateOne(
        {
          _id: userId,
          balance: { $gte: input.initialWager },
        },
        { $inc: { balance: -input.initialWager } },
        { session },
      );

      if (user.modifiedCount !== 1) {
        const exists = await User.exists({ _id: userId })
          .session(session);

        if (!exists) {
          throw new HttpError(401, "User not found");
        }

        throw new HttpError(402, "Insufficient balance");
      }

      const [createdMarket] = await Market.create(
        [
          {
            title: input.title,
            description: input.description ?? "",
            creatorId: userId,
            initialWager: input.initialWager,
            expiresAt: input.expiry,
            side: input.side,
            matchedAmount: 0,
            status: "open",
          },
        ],
        { session },
      );

      await WalletEvent.create(
        [
          {
            userId,
            type: "bet_placed",
            amount: -input.initialWager,
            marketId: createdMarket._id,
          },
        ],
        { session },
      );

      return createdMarket;
    });

    res.status(201).json({
      message: "Market created",
      market,
    });
  }),
);

// ─── GET /markets and /api/v1/market ────────────────────

app.get(
  ["/markets", `${API}/market`],
  asyncHandler(async (_req, res) => {
    const markets = await Market.find({
      status: "open",
      expiresAt: { $gt: new Date() },
    })
      .sort({ createdAt: -1 })
      .populate("creatorId", "username")
      .lean();

    res.json({
      markets: markets.map((market) => ({
        ...market,
        remainingWager: Math.max(
          0,
          market.initialWager - market.matchedAmount,
        ),
      })),
    });
  }),
);

// ─── POST /bet and /api/v1/market/bet ───────────────────
// Bettors automatically take the side opposite the creator.

app.post(
  ["/bet", `${API}/market/bet`],
  authenticate,
  asyncHandler(async (req, res) => {
    const { marketId, amount } = parseBody(
      placeBetSchema,
      req.body,
    );

    const userId = getUserId(req);

    const result = await inTransaction(async (session) => {
      const market = await Market.findById(marketId)
        .session(session);

      if (!market) {
        throw new HttpError(404, "Market not found");
      }

      if (market.status !== "open") {
        throw new HttpError(409, "Market is not open");
      }

      if (market.expiresAt.getTime() <= Date.now()) {
        throw new HttpError(409, "Market has expired");
      }

      if (market.creatorId.toString() === userId) {
        throw new HttpError(
          403,
          "You cannot bet on your own market",
        );
      }

      const available =
        market.initialWager - market.matchedAmount;

      if (amount > available) {
        throw new HttpError(
          409,
          `Bet exceeds remaining capacity (${Math.max(0, available)})`,
        );
      }

      const debit = await User.updateOne(
        {
          _id: userId,
          balance: { $gte: amount },
        },
        { $inc: { balance: -amount } },
        { session },
      );

      if (debit.modifiedCount !== 1) {
        const exists = await User.exists({ _id: userId })
          .session(session);

        if (!exists) {
          throw new HttpError(401, "User not found");
        }

        throw new HttpError(402, "Insufficient balance");
      }

      // Reserve market capacity atomically so concurrent bets
      // cannot push matchedAmount above initialWager.
      const reservation = await Market.updateOne(
        {
          _id: market._id,
          status: "open",
          expiresAt: { $gt: new Date() },
          matchedAmount: {
            $lte: market.initialWager - amount,
          },
        },
        { $inc: { matchedAmount: amount } },
        { session },
      );

      if (reservation.modifiedCount !== 1) {
        throw new HttpError(
          409,
          "Market capacity is no longer available",
        );
      }

      const outcome = market.side === "yes" ? "no" : "yes";

      const [bet] = await Bet.create(
        [
          {
            userId,
            marketId: market._id,
            amount,
            outcome,
            status: "open",
            payout: 0,
          },
        ],
        { session },
      );

      await WalletEvent.create(
        [
          {
            userId,
            type: "bet_placed",
            amount: -amount,
            betId: bet._id,
            marketId: market._id,
          },
        ],
        { session },
      );

      return {
        bet,
        remainingWager: available - amount,
      };
    });

    res.status(201).json({
      message: "Bet placed",
      ...result,
    });
  }),
);

// ─── GET /bets and /api/v1/market/bets ──────────────────

app.get(
  ["/bets", `${API}/market/bets`],
  authenticate,
  asyncHandler(async (req, res) => {
    const bets = await Bet.find({
      userId: getUserId(req),
    })
      .sort({ createdAt: -1 })
      .populate(
        "marketId",
        "title side status resolution expiresAt",
      )
      .lean();

    res.json({ bets });
  }),
);

// ─── POST /resolve and /api/v1/resolve ──────────────────
// Only the creator may resolve an expired market.

app.post(
  ["/resolve", `${API}/resolve`],
  authenticate,
  asyncHandler(async (req, res) => {
    const { marketId, resolution } = parseBody(
      resolveSchema,
      req.body,
    );

    const userId = getUserId(req);

    const summary = await inTransaction(async (session) => {
      const market = await Market.findById(marketId)
        .session(session);

      if (!market) {
        throw new HttpError(404, "Market not found");
      }

      if (market.creatorId.toString() !== userId) {
        throw new HttpError(
          403,
          "Only the market creator can resolve it",
        );
      }

      if (!["open", "closed"].includes(market.status)) {
        throw new HttpError(
          409,
          "Market has already been resolved or cancelled",
        );
      }

      if (market.expiresAt.getTime() > Date.now()) {
        throw new HttpError(
          409,
          "Market cannot be resolved before expiry",
        );
      }

      const bets = await Bet.find({
        marketId: market._id,
        status: "open",
      }).session(session);

      const totalBets = bets.reduce(
        (sum, bet) => sum + bet.amount,
        0,
      );

      if (
        !Number.isSafeInteger(totalBets) ||
        totalBets > market.initialWager ||
        totalBets !== market.matchedAmount
      ) {
        throw new HttpError(
          500,
          "Market accounting invariant violated",
        );
      }

      const creatorWon = resolution === market.side;

      if (creatorWon) {
        // Return the creator's locked stake plus opponents' stakes.
        const creatorCredit = market.initialWager + totalBets;

        const credit = await User.updateOne(
          {
            _id: market.creatorId,
            balance: { $lte: MAX_BALANCE - creatorCredit },
          },
          { $inc: { balance: creatorCredit } },
          { session },
        );

        if (credit.modifiedCount !== 1) {
          throw new HttpError(
            409,
            "Creator balance update failed",
          );
        }

        await WalletEvent.create(
          [
            {
              userId: market.creatorId,
              type: "payout",
              amount: creatorCredit,
              marketId: market._id,
            },
          ],
          { session },
        );

        await Bet.updateMany(
          { marketId: market._id, status: "open" },
          { $set: { status: "lost", payout: 0 } },
          { session },
        );
      } else {
        // Winning opposing bettors receive their stake plus winnings.
        for (const bet of bets) {
          const payout = bet.amount * 2;

          const credit = await User.updateOne(
            {
              _id: bet.userId,
              balance: { $lte: MAX_BALANCE - payout },
            },
            { $inc: { balance: payout } },
            { session },
          );

          if (credit.modifiedCount !== 1) {
            throw new HttpError(
              409,
              "Winning bettor balance update failed",
            );
          }

          bet.status = "won";
          bet.payout = payout;

          await bet.save({ session });

          await WalletEvent.create(
            [
              {
                userId: bet.userId,
                type: "payout",
                amount: payout,
                betId: bet._id,
                marketId: market._id,
              },
            ],
            { session },
          );
        }

        // The creator gets back only the unmatched portion of their stake.
        const creatorRefund =
          market.initialWager - totalBets;

        if (creatorRefund > 0) {
          const refund = await User.updateOne(
            { _id: market.creatorId },
            { $inc: { balance: creatorRefund } },
            { session },
          );

          if (refund.modifiedCount !== 1) {
            throw new HttpError(
              409,
              "Creator refund failed",
            );
          }

          await WalletEvent.create(
            [
              {
                userId: market.creatorId,
                type: "refund",
                amount: creatorRefund,
                marketId: market._id,
              },
            ],
            { session },
          );
        }
      }

      market.status = "resolved";
      market.resolution = resolution;
      market.resolvedAt = new Date();

      await market.save({ session });

      return {
        marketId: market.id,
        resolution,
        creatorWon,
        totalBets,
        creatorRefund: creatorWon
          ? 0
          : market.initialWager - totalBets,
      };
    });

    res.json({
      message: "Market resolved successfully",
      ...summary,
    });
  }),
);

// ─── 404 and error handling ─────────────────────────────

app.use((_req, res) => {
  res.status(404).json({
    message: "Endpoint not found",
  });
});

const errorHandler: ErrorRequestHandler = (
  error,
  _req,
  res,
  _next,
) => {
  if (error instanceof HttpError) {
    res.status(error.status).json({
      message: error.message,
      ...(error.details ? { errors: error.details } : {}),
    });
    return;
  }

  if (isDuplicateKey(error)) {
    res.status(409).json({
      message: "Username already exists",
    });
    return;
  }

  if (error instanceof mongoose.Error.ValidationError) {
    res.status(400).json({
      message: "Database validation failed",
    });
    return;
  }

  console.error("Unhandled API error:", error);

  res.status(500).json({
    message: "Internal server error",
  });
};

app.use(errorHandler);

// ─── Startup ────────────────────────────────────────────

async function start(): Promise<void> {
  await connectDB();

  app.listen(PORT, () => {
    console.log(`API listening on http://localhost:${PORT}`);
  });
}

start().catch((error: unknown) => {
  console.error("Server startup failed:", error);
  process.exit(1);
});