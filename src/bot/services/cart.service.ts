import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf, Markup, Context } from 'telegraf';
import { Cart, CartDocument } from '../schemas/cart.schema';
import { Product, ProductDocument } from '../schemas/product.schema';
import { User, UserDocument, RegistrationStep } from '../schemas/user.schema';

@Injectable()
export class CartService implements OnModuleInit {
  private readonly logger = new Logger(CartService.name);

  constructor(
    @InjectModel(Cart.name) private readonly cartModel: Model<CartDocument>,
    @InjectModel(Product.name) private readonly productModel: Model<ProductDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectBot() private readonly bot: Telegraf<Context>,
  ) {}

  onModuleInit() {
    this.registerHandlers();
  }

  private registerHandlers() {
    // Add to cart
    this.bot.action(/^add_to_cart:(.+)$/, async (ctx) => {
      try {
        await ctx.answerCbQuery('Added to cart! 🛒');
        const productId = ctx.match[1];
        await this.handleAddToCart(ctx, productId);
      } catch (err) {
        this.logger.error('Error adding to cart', err);
      }
    });

    // View cart
    this.bot.action('view_cart', async (ctx) => {
      try {
        await ctx.answerCbQuery();
        await this.handleViewCart(ctx);
      } catch (err) {
        this.logger.error('Error viewing cart', err);
      }
    });

    // Remove item from cart
    this.bot.action(/^remove_from_cart:(.+)$/, async (ctx) => {
      try {
        await ctx.answerCbQuery();
        const productId = ctx.match[1];
        await this.handleRemoveFromCart(ctx, productId);
      } catch (err) {
        this.logger.error('Error removing from cart', err);
      }
    });

    // Increase item quantity
    this.bot.action(/^cart_inc:(.+)$/, async (ctx) => {
      try {
        await ctx.answerCbQuery();
        const productId = ctx.match[1];
        await this.handleChangeQuantity(ctx, productId, 1);
      } catch (err) {
        this.logger.error('Error increasing quantity', err);
      }
    });

    // Decrease item quantity
    this.bot.action(/^cart_dec:(.+)$/, async (ctx) => {
      try {
        await ctx.answerCbQuery();
        const productId = ctx.match[1];
        await this.handleChangeQuantity(ctx, productId, -1);
      } catch (err) {
        this.logger.error('Error decreasing quantity', err);
      }
    });

    // Clear entire cart
    this.bot.action('clear_cart', async (ctx) => {
      try {
        await ctx.answerCbQuery();
        await this.handleClearCart(ctx);
      } catch (err) {
        this.logger.error('Error clearing cart', err);
      }
    });
  }

  // ─── Handlers ─────────────────────────────────────────────────────────────

  private async handleAddToCart(ctx: Context, productId: string) {
    const chatId = ctx.from?.id;
    if (!chatId) return;

    const user = await this.userModel.findOne({ chatId });
    if (!user || user.registrationStep !== RegistrationStep.COMPLETE) {
      await ctx.reply('⚠️ Please complete registration first. Send /start');
      return;
    }

    const product = await this.productModel.findById(productId);
    if (!product || !product.isActive) {
      await ctx.reply('❌ Product not available.');
      return;
    }

    let cart = await this.cartModel.findOne({ chatId });
    if (!cart) {
      cart = await this.cartModel.create({ chatId, items: [], total: 0 });
    }

    const existingItem = cart.items.find(
      (item) => item.productId.toString() === productId,
    );

    if (existingItem) {
      existingItem.quantity += 1;
    } else {
      cart.items.push({
        productId: new Types.ObjectId(productId),
        name: product.name,
        price: product.price,
        quantity: 1,
      });
    }

    cart.total = this.calculateTotal(cart.items);
    await cart.save();

    await ctx.reply(
      `✅ *${product.name}* added to cart!\n💰 Cart total: $${cart.total.toFixed(2)}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🛒 View Cart', 'view_cart')],
          [Markup.button.callback('🏠 Main Menu', 'main_menu')],
        ]),
      },
    );
  }

  private async handleViewCart(ctx: Context) {
    const chatId = ctx.from?.id;
    if (!chatId) return;

    const user = await this.userModel.findOne({ chatId });
    if (!user || user.registrationStep !== RegistrationStep.COMPLETE) {
      await ctx.reply('⚠️ Please complete registration first. Send /start');
      return;
    }

    const cart = await this.cartModel.findOne({ chatId });

    if (!cart || cart.items.length === 0) {
      const emptyMessage = '🛒 *Your Cart*\n\nYour cart is empty.';
      try {
        await ctx.editMessageText(emptyMessage, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🍔 Browse Menu', 'category:food')],
            [Markup.button.callback('🏠 Main Menu', 'main_menu')],
          ]),
        });
      } catch {
        await ctx.replyWithMarkdown(
          emptyMessage,
          Markup.inlineKeyboard([
            [Markup.button.callback('🍔 Browse Menu', 'category:food')],
            [Markup.button.callback('🏠 Main Menu', 'main_menu')],
          ]),
        );
      }
      return;
    }

    const itemLines = cart.items
      .map(
        (item, i) =>
          `${i + 1}. ${item.name} × ${item.quantity} = ${(item.price * item.quantity).toFixed(2)} UZS`,
      )
      .join('\n');

    const cartText =
      `🛒 *Your Cart*\n\n${itemLines}\n\n` +
      `─────────────────\n` +
      `💰 *Total: ${cart.total.toFixed(2)} UZS*\n` +
      `💳 Your balance: ${user.balance.toFixed(2)} UZS`;

    // Build item control buttons
    const itemButtons = cart.items.map((item) => [
      Markup.button.callback(`➖`, `cart_dec:${item.productId}`),
      Markup.button.callback(`${item.name} (${item.quantity})`, `noop`),
      Markup.button.callback(`➕`, `cart_inc:${item.productId}`),
      Markup.button.callback(`🗑`, `remove_from_cart:${item.productId}`),
    ]);

    const actionButtons = [
      [Markup.button.callback('✅ Confirm Order', 'confirm_order')],
      [
        Markup.button.callback('🗑 Clear Cart', 'clear_cart'),
        Markup.button.callback('🏠 Main Menu', 'main_menu'),
      ],
    ];

    const allButtons = [...itemButtons, ...actionButtons];

    try {
      await ctx.editMessageText(cartText, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(allButtons),
      });
    } catch {
      await ctx.replyWithMarkdown(cartText, Markup.inlineKeyboard(allButtons));
    }
  }

  private async handleRemoveFromCart(ctx: Context, productId: string) {
    const chatId = ctx.from?.id;
    if (!chatId) return;

    const cart = await this.cartModel.findOne({ chatId });
    if (!cart) return;

    cart.items = cart.items.filter(
      (item) => item.productId.toString() !== productId,
    );
    cart.total = this.calculateTotal(cart.items);
    await cart.save();

    await this.handleViewCart(ctx);
  }

  private async handleChangeQuantity(
    ctx: Context,
    productId: string,
    delta: number,
  ) {
    const chatId = ctx.from?.id;
    if (!chatId) return;

    const cart = await this.cartModel.findOne({ chatId });
    if (!cart) return;

    const item = cart.items.find(
      (i) => i.productId.toString() === productId,
    );

    if (!item) return;

    item.quantity += delta;

    if (item.quantity <= 0) {
      cart.items = cart.items.filter(
        (i) => i.productId.toString() !== productId,
      );
    }

    cart.total = this.calculateTotal(cart.items);
    await cart.save();

    await this.handleViewCart(ctx);
  }

  private async handleClearCart(ctx: Context) {
    const chatId = ctx.from?.id;
    if (!chatId) return;

    await this.cartModel.updateOne(
      { chatId },
      { items: [], total: 0 },
    );

    try {
      await ctx.editMessageText('🗑 Cart cleared.', {
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🍔 Browse Menu', 'category:food')],
          [Markup.button.callback('🏠 Main Menu', 'main_menu')],
        ]),
      });
    } catch {
      await ctx.reply(
        '🗑 Cart cleared.',
        Markup.inlineKeyboard([
          [Markup.button.callback('🏠 Main Menu', 'main_menu')],
        ]),
      );
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private calculateTotal(items: CartDocument['items']): number {
    return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  }

  async getCart(chatId: number): Promise<CartDocument | null> {
    return this.cartModel.findOne({ chatId });
  }

  async clearCart(chatId: number): Promise<void> {
    await this.cartModel.updateOne({ chatId }, { items: [], total: 0 });
  }
}
