
import type { Request, Response, NextFunction } from "express";
import bcrypt from "bcrypt";
import jwt, { type JwtPayload } from "jsonwebtoken";

const JWT_EXPIRES_IN = "1d";
const SALT_ROUNDS = 12;

export interface AuthPayload {
  userId: string;
  role: "user" | "admin";
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthPayload;
    }
  }
}

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;

  if (!secret || secret.length < 32) {
    throw new Error(
      "JWT_SECRET must be configured with a sufficiently long random secret",
    );
  }

  return secret;
}

export async function hashPassword(
  password: string,
): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(
  password: string,
  passwordHash: string,
): Promise<boolean> {
  return bcrypt.compare(password, passwordHash);
}

export function generateToken(
  payload: AuthPayload,
): string {
  return jwt.sign(
    {
      sub: payload.userId,
      role: payload.role,
    },
    getJwtSecret(),
    { expiresIn: JWT_EXPIRES_IN },
  );
}

export function authenticate(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const authorization = req.headers.authorization;

  if (!authorization?.startsWith("Bearer ")) {
    res.status(401).json({
      message: "Authentication required",
    });
    return;
  }

  const token = authorization.slice(7);

  try {
    const decoded = jwt.verify(token, getJwtSecret());

    if (typeof decoded === "string") {
      res.status(401).json({ message: "Invalid token" });
      return;
    }

    const payload = decoded as JwtPayload;
    const userId = payload.sub;
    const role = payload.role;

    if (
      typeof userId !== "string" ||
      !["user", "admin"].includes(role)
    ) {
      res.status(401).json({
        message: "Invalid token payload",
      });
      return;
    }

    req.auth = {
      userId,
      role: role as AuthPayload["role"],
    };

    next();
  } catch {
    res.status(401).json({
      message: "Invalid or expired token",
    });
  }
}

export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.auth) {
    res.status(401).json({
      message: "Authentication required",
    });
    return;
  }

  if (req.auth.role !== "admin") {
    res.status(403).json({
      message: "Admin access required",
    });
    return;
  }

  next();
}