import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf, Markup, Context } from 'telegraf';
import { Order, OrderDocument, OrderStatus } from '../schemas/order.schema';
import { Cart, CartDocument } from '../schemas/cart.schema';
import { User, UserDocument, UserRole, RegistrationStep } from '../schemas/user.schema';

@Injectable()
export class OrderService implements OnModuleInit {
  private readonly logger = new Logger(OrderService.name);

  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @InjectModel(Cart.name) private readonly cartModel: Model<CartDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectBot() private readonly bot: Telegraf<Context>,
  ) {}

  onModuleInit() {
    this.registerHandlers();
  }

  private registerHandlers() {
    // Confirm order from cart
    this.bot.action('confirm_order', async (ctx) => {
      try {
        await ctx.answerCbQuery();
        await this.handleConfirmOrder(ctx);
      } catch (err) {
        this.logger.error('Error confirming order', err);
      }
    });

    // Pay for order (deduct balance)
    this.bot.action(/^pay_order:(.+)$/, async (ctx) => {
      try {
        await ctx.answerCbQuery();
        const orderId = ctx.match[1];
        await this.handlePayOrder(ctx, orderId);
      } catch (err) {
        this.logger.error('Error paying for order', err);
      }
    });

    // Cancel order before payment
    this.bot.action(/^cancel_order:(.+)$/, async (ctx) => {
      try {
        await ctx.answerCbQuery();
        const orderId = ctx.match[1];
        await this.handleCancelOrder(ctx, orderId);
      } catch (err) {
        this.logger.error('Error cancelling order', err);
      }
    });

    // View user's own orders
    this.bot.action('my_orders', async (ctx) => {
      try {
        await ctx.answerCbQuery();
        await this.handleMyOrders(ctx);
      } catch (err) {
        this.logger.error('Error viewing my orders', err);
      }
    });

    // Manager: view all orders
    this.bot.action('all_orders', async (ctx) => {
      try {
        await ctx.answerCbQuery();
        await this.handleAllOrders(ctx);
      } catch (err) {
        this.logger.error('Error viewing all orders', err);
      }
    });

    // Manager: update order status
    this.bot.action(/^update_order:([^:]+):(.+)$/, async (ctx) => {
      try {
        await ctx.answerCbQuery();
        const orderId = ctx.match[1];
        const status = ctx.match[2] as OrderStatus;
        await this.handleUpdateOrderStatus(ctx, orderId, status);
      } catch (err) {
        this.logger.error('Error updating order status', err);
      }
    });

    // View single order details
    this.bot.action(/^order_detail:(.+)$/, async (ctx) => {
      try {
        await ctx.answerCbQuery();
        const orderId = ctx.match[1];
        await this.handleOrderDetail(ctx, orderId);
      } catch (err) {
        this.logger.error('Error viewing order detail', err);
      }
    });

    // No-op for display-only buttons
    this.bot.action('noop', async (ctx) => {
      await ctx.answerCbQuery();
    });
  }

  // ─── Order Confirmation Flow ───────────────────────────────────────────────

  private async handleConfirmOrder(ctx: Context) {
    const chatId = ctx.from?.id;
    if (!chatId) return;

    const user = await this.userModel.findOne({ chatId });
    if (!user || user.registrationStep !== RegistrationStep.COMPLETE) {
      await ctx.reply('⚠️ Please complete registration first. Send /start');
      return;
    }

    const cart = await this.cartModel.findOne({ chatId });
    if (!cart || cart.items.length === 0) {
      await ctx.reply('🛒 Your cart is empty.');
      return;
    }

    // Show order summary before payment
    const itemLines = cart.items
      .map((item) => `• ${item.name} × ${item.quantity} = $${(item.price * item.quantity).toFixed(2)}`)
      .join('\n');

    const summaryText =
      `📋 *Order Summary*\n\n` +
      `${itemLines}\n\n` +
      `─────────────────\n` +
      `💰 *Total: $${cart.total.toFixed(2)}*\n` +
      `💳 Your balance: $${user.balance.toFixed(2)}\n\n` +
      (user.balance < cart.total
        ? `⚠️ *Insufficient balance!* You need $${(cart.total - user.balance).toFixed(2)} more.`
        : `✅ You have enough balance to pay.`);

    // Create a pending order first
    const order = await this.orderModel.create({
      chatId,
      customerName: `${user.firstName} ${user.lastName || ''}`.trim(),
      items: cart.items.map((item) => ({
        productId: item.productId,
        name: item.name,
        price: item.price,
        quantity: item.quantity,
      })),
      total: cart.total,
      status: OrderStatus.PENDING,
      deliveryLocation: user.location,
      phone: user.phone,
    });

    const buttons = user.balance >= cart.total
      ? [
          [Markup.button.callback('💳 Pay Now', `pay_order:${order._id}`)],
          [Markup.button.callback('❌ Cancel', `cancel_order:${order._id}`)],
        ]
      : [
          [Markup.button.callback('❌ Cancel Order', `cancel_order:${order._id}`)],
          [Markup.button.callback('🏠 Main Menu', 'main_menu')],
        ];

    try {
      await ctx.editMessageText(summaryText, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(buttons),
      });
    } catch {
      await ctx.replyWithMarkdown(summaryText, Markup.inlineKeyboard(buttons));
    }
  }

  // ─── Payment ───────────────────────────────────────────────────────────────

  private async handlePayOrder(ctx: Context, orderId: string) {
    const chatId = ctx.from?.id;
    if (!chatId) return;

    const [order, user] = await Promise.all([
      this.orderModel.findById(orderId),
      this.userModel.findOne({ chatId }),
    ]);

    if (!order || !user) {
      await ctx.reply('❌ Order not found.');
      return;
    }

    if (order.chatId !== chatId) {
      await ctx.reply('❌ Unauthorized.');
      return;
    }

    if (order.status !== OrderStatus.PENDING) {
      await ctx.reply('⚠️ This order has already been processed.');
      return;
    }

    if (user.balance < order.total) {
      await ctx.editMessageText(
        `❌ *Insufficient Balance*\n\n` +
          `Required: $${order.total.toFixed(2)}\n` +
          `Your balance: $${user.balance.toFixed(2)}\n` +
          `Shortfall: $${(order.total - user.balance).toFixed(2)}`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('❌ Cancel Order', `cancel_order:${orderId}`)],
            [Markup.button.callback('🏠 Main Menu', 'main_menu')],
          ]),
        },
      );
      return;
    }

    // Deduct balance atomically
    const updatedUser = await this.userModel.findOneAndUpdate(
      { chatId, balance: { $gte: order.total } },
      { $inc: { balance: -order.total } },
      { new: true },
    );

    if (!updatedUser) {
      await ctx.reply('❌ Payment failed: insufficient balance.');
      return;
    }

    // Clear cart after successful payment
    await this.cartModel.updateOne({ chatId }, { items: [], total: 0 });

    await ctx.editMessageText(
      `✅ *Payment Successful!*\n\n` +
        `📦 Order #${order._id.toString().slice(-6).toUpperCase()}\n` +
        `💰 Paid: $${order.total.toFixed(2)}\n` +
        `💳 Remaining balance: $${updatedUser.balance.toFixed(2)}\n\n` +
        `Your order is now *pending* and will be prepared soon! 🍔`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📦 My Orders', 'my_orders')],
          [Markup.button.callback('🏠 Main Menu', 'main_menu')],
        ]),
      },
    );

    // Notify all managers about new order
    await this.notifyManagersNewOrder(order, user);
  }

  private async notifyManagersNewOrder(order: OrderDocument, customer: UserDocument) {
    const managers = await this.userModel.find({ role: UserRole.MANAGER });
    const shortId = order._id.toString().slice(-6).toUpperCase();
    const itemLines = order.items
      .map((i) => `• ${i.name} × ${i.quantity}`)
      .join('\n');

    const notificationText =
      `🔔 *New Order Received!*\n\n` +
      `Order #${shortId}\n` +
      `👤 Customer: ${customer.firstName}\n` +
      `📱 Phone: ${customer.phone}\n` +
      `📦 Items:\n${itemLines}\n` +
      `💰 Total: $${order.total.toFixed(2)}`;

    for (const manager of managers) {
      try {
        await this.bot.telegram.sendMessage(manager.chatId, notificationText, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback(
                '✅ Accept',
                `update_order:${order._id}:${OrderStatus.ACCEPTED}`,
              ),
            ],
            [Markup.button.callback('📋 View Details', `order_detail:${order._id}`)],
          ]),
        });
      } catch {
        // Manager may have blocked the bot
        this.logger.warn(`Could not notify manager ${manager.chatId}`);
      }
    }
  }

  // ─── Order Cancellation ────────────────────────────────────────────────────

  private async handleCancelOrder(ctx: Context, orderId: string) {
    const chatId = ctx.from?.id;
    if (!chatId) return;

    const order = await this.orderModel.findById(orderId);
    if (!order || order.chatId !== chatId) {
      await ctx.reply('❌ Order not found.');
      return;
    }

    if (order.status !== OrderStatus.PENDING) {
      await ctx.reply('⚠️ Cannot cancel an order that is already being processed.');
      return;
    }

    await this.orderModel.deleteOne({ _id: orderId });

    try {
      await ctx.editMessageText(
        '❌ Order cancelled.',
        Markup.inlineKeyboard([[Markup.button.callback('🏠 Main Menu', 'main_menu')]]),
      );
    } catch {
      await ctx.reply('❌ Order cancelled.', Markup.inlineKeyboard([[Markup.button.callback('🏠 Main Menu', 'main_menu')]]));
    }
  }

  // ─── Order History ─────────────────────────────────────────────────────────

  private async handleMyOrders(ctx: Context) {
    const chatId = ctx.from?.id;
    if (!chatId) return;

    const orders = await this.orderModel
      .find({ chatId })
      .sort({ createdAt: -1 })
      .limit(10);

    if (orders.length === 0) {
      const text = '📦 *My Orders*\n\nYou have no orders yet.';
      try {
        await ctx.editMessageText(text, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Main Menu', 'main_menu')]]),
        });
      } catch {
        await ctx.replyWithMarkdown(text, Markup.inlineKeyboard([[Markup.button.callback('🏠 Main Menu', 'main_menu')]]));
      }
      return;
    }

    const statusEmoji = {
      [OrderStatus.PENDING]: '⏳',
      [OrderStatus.ACCEPTED]: '✅',
      [OrderStatus.DELIVERED]: '🚚',
    };

    const orderButtons = orders.map((order) => [
      Markup.button.callback(
        `${statusEmoji[order.status]} #${order._id.toString().slice(-6).toUpperCase()} — $${order.total.toFixed(2)} — ${order.status}`,
        `order_detail:${order._id}`,
      ),
    ]);

    orderButtons.push([Markup.button.callback('🏠 Main Menu', 'main_menu')]);

    const text = `📦 *My Orders* (last ${orders.length})`;
    try {
      await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(orderButtons),
      });
    } catch {
      await ctx.replyWithMarkdown(text, Markup.inlineKeyboard(orderButtons));
    }
  }

  private async handleAllOrders(ctx: Context) {
    const chatId = ctx.from?.id;
    if (!chatId) return;

    const user = await this.userModel.findOne({ chatId });
    if (!user || user.role !== UserRole.MANAGER) {
      await ctx.reply('❌ Manager access only.');
      return;
    }

    const orders = await this.orderModel
      .find()
      .sort({ createdAt: -1 })
      .limit(20);

    if (orders.length === 0) {
      const text = '📊 *All Orders*\n\nNo orders yet.';
      try {
        await ctx.editMessageText(text, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Main Menu', 'main_menu')]]),
        });
      } catch {
        await ctx.replyWithMarkdown(text, Markup.inlineKeyboard([[Markup.button.callback('🏠 Main Menu', 'main_menu')]]));
      }
      return;
    }

    const statusEmoji = {
      [OrderStatus.PENDING]: '⏳',
      [OrderStatus.ACCEPTED]: '✅',
      [OrderStatus.DELIVERED]: '🚚',
    };

    const orderButtons = orders.map((order) => [
      Markup.button.callback(
        `${statusEmoji[order.status]} #${order._id.toString().slice(-6).toUpperCase()} | ${order.customerName} | $${order.total.toFixed(2)}`,
        `order_detail:${order._id}`,
      ),
    ]);

    orderButtons.push([Markup.button.callback('🏠 Main Menu', 'main_menu')]);

    const text = `📊 *All Orders* (last ${orders.length})`;
    try {
      await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(orderButtons),
      });
    } catch {
      await ctx.replyWithMarkdown(text, Markup.inlineKeyboard(orderButtons));
    }
  }

  private async handleOrderDetail(ctx: Context, orderId: string) {
    const chatId = ctx.from?.id;
    if (!chatId) return;

    const user = await this.userModel.findOne({ chatId });
    const order = await this.orderModel.findById(orderId);

    if (!order) {
      await ctx.reply('❌ Order not found.');
      return;
    }

    // Customers can only see their own orders
    if (user.role === UserRole.CUSTOMER && order.chatId !== chatId) {
      await ctx.reply('❌ Unauthorized.');
      return;
    }

    const statusEmoji = {
      [OrderStatus.PENDING]: '⏳ Pending',
      [OrderStatus.ACCEPTED]: '✅ Accepted',
      [OrderStatus.DELIVERED]: '🚚 Delivered',
    };

    const itemLines = order.items
      .map((item) => `• ${item.name} × ${item.quantity} — $${(item.price * item.quantity).toFixed(2)}`)
      .join('\n');

    const detailText =
      `📦 *Order #${order._id.toString().slice(-6).toUpperCase()}*\n\n` +
      `👤 Customer: ${order.customerName}\n` +
      `📱 Phone: ${order.phone || 'N/A'}\n` +
      `📋 Status: ${statusEmoji[order.status]}\n\n` +
      `*Items:*\n${itemLines}\n\n` +
      `─────────────────\n` +
      `💰 *Total: $${order.total.toFixed(2)}*`;

    const buttons: any[][] = [];

    // Manager can update status
    if (user.role === UserRole.MANAGER) {
      if (order.status === OrderStatus.PENDING) {
        buttons.push([
          Markup.button.callback('✅ Accept', `update_order:${orderId}:${OrderStatus.ACCEPTED}`),
        ]);
      }
      if (order.status === OrderStatus.ACCEPTED) {
        buttons.push([
          Markup.button.callback('🚚 Mark Delivered', `update_order:${orderId}:${OrderStatus.DELIVERED}`),
        ]);
      }
      buttons.push([Markup.button.callback('📊 All Orders', 'all_orders')]);
    } else {
      buttons.push([Markup.button.callback('📦 My Orders', 'my_orders')]);
    }

    buttons.push([Markup.button.callback('🏠 Main Menu', 'main_menu')]);

    try {
      await ctx.editMessageText(detailText, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(buttons),
      });
    } catch {
      await ctx.replyWithMarkdown(detailText, Markup.inlineKeyboard(buttons));
    }
  }

  // ─── Manager: Update Order Status ─────────────────────────────────────────

  private async handleUpdateOrderStatus(
    ctx: Context,
    orderId: string,
    status: OrderStatus,
  ) {
    const chatId = ctx.from?.id;
    if (!chatId) return;

    const manager = await this.userModel.findOne({ chatId });
    if (!manager || manager.role !== UserRole.MANAGER) {
      await ctx.reply('❌ Manager access only.');
      return;
    }

    const order = await this.orderModel.findByIdAndUpdate(
      orderId,
      { status },
      { new: true },
    );

    if (!order) {
      await ctx.reply('❌ Order not found.');
      return;
    }

    await ctx.reply(
      `✅ Order #${order._id.toString().slice(-6).toUpperCase()} status updated to *${status.toUpperCase()}*`,
      { parse_mode: 'Markdown' },
    );

    // Notify the customer about their order status update
    const statusMessages = {
      [OrderStatus.ACCEPTED]: '✅ Your order has been *accepted* and is being prepared!',
      [OrderStatus.DELIVERED]: '🚚 Your order has been *delivered*! Enjoy your meal! 🍔',
    };

    if (statusMessages[status]) {
      try {
        await this.bot.telegram.sendMessage(
          order.chatId,
          `📦 *Order Update*\n\nOrder #${order._id.toString().slice(-6).toUpperCase()}\n\n${statusMessages[status]}`,
          { parse_mode: 'Markdown' },
        );
      } catch {
        this.logger.warn(`Could not notify customer ${order.chatId}`);
      }
    }
  }
}
