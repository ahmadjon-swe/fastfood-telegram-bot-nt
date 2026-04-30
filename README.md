# 🍔 Fastfood Delivery Telegram Bot

A production-ready Telegram bot built with **NestJS**, **nestjs-telegraf**, **MongoDB (Mongoose)**, and **TypeScript**.

---

## Architecture

```
src/
├── main.ts
├── app.module.ts
└── bot/
    ├── bot.module.ts           # Module wiring (Telegraf + Mongoose)
    ├── schemas/
    │   ├── user.schema.ts      # User model (chatId, phone, location, role, balance)
    │   ├── product.schema.ts   # Product model (name, price, image, category, isActive)
    │   ├── cart.schema.ts      # Cart model (items[], total)
    │   └── order.schema.ts     # Order model (items[], status, deliveryLocation)
    └── services/
        ├── bot.service.ts      # Top-level orchestrator (help, balance, fallback guard)
        ├── user.service.ts     # Registration flow, role management, profile
        ├── product.service.ts  # Category browse, product CRUD wizard, toggle
        ├── cart.service.ts     # Add/remove/quantity, cart view, clear
        └── order.service.ts    # Confirm, payment, status updates, notifications
```

### Architecture Principles

- **No `@Update()` / `@On()` / `@Start()` decorators** — all Telegraf handlers are registered programmatically in `service.ts` files via `OnModuleInit.onModuleInit()`.
- Each service calls `this.bot.action(...)`, `this.bot.command(...)`, and `this.bot.on(...)` directly, giving full control over handler registration order.
- Services are **self-contained** — each registers its own handlers and owns its domain logic.

---

## Features

### 1. User Registration
- `/start` auto-registers the user
- Forces phone collection (contact button) → location collection (location button)
- User is **blocked** from all features until both phone and location are provided
- Roles: `customer`, `seller`, `manager`
- Welcome balance: **$100** on first registration

### 2. Category & Product Browsing
- Inline keyboard menu: 🍔 Food | 🥤 Drinks | 🍰 Desserts
- Each product shown with price, description, optional photo
- **Add to Cart** button per product
- Sellers/Managers can activate/deactivate products inline

### 3. Product Management (Seller/Manager)
- Step-by-step wizard: name → price → description → image URL → category
- Toggle product active/inactive from the product view
- `/promote <chatId> <seller|manager>` — manager promotes users

### 4. Cart System
- Add items with ➕ / ➖ quantity controls
- Remove individual items 🗑
- Clear entire cart
- Real-time total recalculation

### 5. Order System
- Confirm cart → creates pending order → pay with balance
- Balance check before payment
- Atomic balance deduction
- Order statuses: `pending` → `accepted` → `delivered`
- Managers notified instantly on new orders
- Customers notified on status updates

### 6. Payment (Mock)
- Balance stored in MongoDB per user
- Deducted atomically on order payment
- `/topup <chatId> <amount>` — manager tops up user balance
- `/balance` — check current balance

---

## Setup

### Prerequisites
- Node.js >= 18
- MongoDB (local or Atlas)
- A Telegram Bot Token from [@BotFather](https://t.me/BotFather)

### Installation

```bash
git clone <repo>
cd fastfood-delivery-bot
npm install
```

### Configuration

Create a `.env` file:
```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
MONGODB_URI=mongodb://localhost:27017/fastfood-bot
NODE_ENV=development
```

### Running

```bash
# Development
npm run start:dev

# Production
npm run build
npm run start:prod
```

---

## Bot Commands

| Command | Access | Description |
|---|---|---|
| `/start` | All | Register / Show main menu |
| `/help` | All | Show help text |
| `/profile` | All | View your profile |
| `/balance` | All | Check wallet balance |
| `/promote <chatId> <role>` | Manager | Promote user to seller/manager |
| `/topup <chatId> <amount>` | Manager | Top up user balance |

---

## Handler Registration Order

The provider order in `BotModule` determines Telegraf middleware registration:

1. `UserService` — `/start`, contact, location (must be first)
2. `ProductService` — categories, product wizard, profile view, main_menu
3. `CartService` — add_to_cart, view_cart, cart controls
4. `OrderService` — confirm_order, pay_order, status updates
5. `BotService` — help, balance, fallback message guard (last)

---

## Making the First Manager

Since managers must be created manually, set the first manager directly in MongoDB:

```js
db.users.updateOne(
  { chatId: YOUR_CHAT_ID },
  { $set: { role: "manager" } }
)
```

Then use `/promote` to delegate from there.

---

## MongoDB Collections

| Collection | Purpose |
|---|---|
| `users` | User profiles, roles, balances, registration state |
| `products` | Menu items by category |
| `carts` | Per-user active shopping cart |
| `orders` | Placed orders with status history |
