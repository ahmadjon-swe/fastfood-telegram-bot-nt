import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf, Markup, Context } from 'telegraf';
import { Message } from 'telegraf/typings/core/types/typegram';
import { Product, ProductDocument, ProductCategory } from '../schemas/product.schema';
import { User, UserDocument, UserRole, RegistrationStep } from '../schemas/user.schema';

interface ProductWizardState {
  step: 'name' | 'price' | 'description' | 'image' | 'category';
  name?: string;
  price?: number;
  description?: string;
  image?: string;
}

@Injectable()
export class ProductService implements OnModuleInit {
  private readonly logger = new Logger(ProductService.name);
  private wizardStates = new Map<number, ProductWizardState>();

  constructor(
    @InjectModel(Product.name) private readonly productModel: Model<ProductDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectBot() private readonly bot: Telegraf<Context>,
  ) {}

  onModuleInit() {
    this.registerHandlers();
  }

  private registerHandlers() {
    this.bot.action(/^category:(.+)$/, async (ctx) => {
      try {
        await ctx.answerCbQuery();
        const category = ctx.match[1] as ProductCategory;
        await this.handleCategoryView(ctx, category);
      } catch (err) {
        this.logger.error('Error in category action', err);
      }
    });

    this.bot.action('add_product', async (ctx) => {
      try {
        await ctx.answerCbQuery();
        await this.startAddProductWizard(ctx);
      } catch (err) {
        this.logger.error('Error starting product wizard', err);
      }
    });

    this.bot.action(/^set_category:(.+)$/, async (ctx) => {
      try {
        await ctx.answerCbQuery();
        const category = ctx.match[1] as ProductCategory;
        await this.handleWizardCategorySelect(ctx, category);
      } catch (err) {
        this.logger.error('Error in set_category action', err);
      }
    });

    this.bot.action(/^toggle_product:(.+)$/, async (ctx) => {
      try {
        await ctx.answerCbQuery();
        const productId = ctx.match[1];
        await this.handleToggleProduct(ctx, productId);
      } catch (err) {
        this.logger.error('Error toggling product', err);
      }
    });

    this.bot.action('main_menu', async (ctx) => {
      try {
        await ctx.answerCbQuery();
        await this.sendMainMenuEdit(ctx);
      } catch (err) {
        this.logger.error('Error in main_menu action', err);
      }
    });

    this.bot.action('view_profile', async (ctx) => {
      try {
        await ctx.answerCbQuery();
        const user = await this.userModel.findOne({ chatId: ctx.from?.id });
        if (!user) return;
        const profileText =
          `👤 *Your Profile*\n\n` +
          `Name: ${user.firstName} ${user.lastName || ''}\n` +
          `Phone: ${user.phone}\n` +
          `Role: ${user.role.toUpperCase()}\n` +
          `💰 Balance: $${user.balance.toFixed(2)}`;
        await ctx.editMessageText(profileText, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Main Menu', 'main_menu')]]),
        });
      } catch (err) {
        this.logger.error('Error in view_profile action', err);
      }
    });

    // Wizard text interceptor — fires before other text handlers
    this.bot.on('text', async (ctx, next) => {
      const chatId = ctx.from?.id;
      if (!chatId) return next();
      const state = this.wizardStates.get(chatId);
      if (!state) return next();
      const text = (ctx.message as Message.TextMessage)?.text;
      if (text?.startsWith('/')) return next();
      try {
        await this.handleWizardText(ctx, state);
      } catch (err) {
        this.logger.error('Error in product wizard text handler', err);
        return next();
      }
    });
  }

  private async sendMainMenuEdit(ctx: Context) {
    const user = await this.userModel.findOne({ chatId: ctx.from?.id });
    if (!user) return;
    const isPrivileged = user.role === UserRole.MANAGER || user.role === UserRole.SELLER;
    const menuText =
      `🏠 *Main Menu*\n\n` +
      `👤 ${user.firstName} | 💰 Balance: $${user.balance.toFixed(2)}\n` +
      `🔖 Role: ${user.role.toUpperCase()}`;
    const buttons: ReturnType<typeof Markup.button.callback>[][] = [
      [
        Markup.button.callback('🍔 Food', 'category:food'),
        Markup.button.callback('🥤 Drinks', 'category:drinks'),
        Markup.button.callback('🍰 Desserts', 'category:desserts'),
      ],
      [
        Markup.button.callback('🛒 Cart', 'view_cart'),
        Markup.button.callback('👤 Profile', 'view_profile'),
      ],
      [Markup.button.callback('📦 My Orders', 'my_orders')],
    ];
    if (isPrivileged) buttons.push([Markup.button.callback('➕ Add Product', 'add_product')]);
    if (user.role === UserRole.MANAGER) buttons.push([Markup.button.callback('📊 All Orders', 'all_orders')]);
    try {
      await ctx.editMessageText(menuText, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
    } catch {
      await ctx.replyWithMarkdown(menuText, Markup.inlineKeyboard(buttons));
    }
  }

  async handleCategoryView(ctx: Context, category: ProductCategory) {
    const chatId = ctx.from?.id;
    if (!chatId) return;
    const user = await this.userModel.findOne({ chatId });
    if (!user || user.registrationStep !== RegistrationStep.COMPLETE) {
      await ctx.reply('⚠️ Please complete registration first. Send /start');
      return;
    }
    const products = await this.productModel.find({ category, isActive: true });
    const emoji = { food: '🍔', drinks: '🥤', desserts: '🍰' }[category];
    const title = category.charAt(0).toUpperCase() + category.slice(1);
    if (products.length === 0) {
      try {
        await ctx.editMessageText(`${emoji} *${title}*\n\nNo products available right now.`, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Main Menu', 'main_menu')]]),
        });
      } catch {
        await ctx.replyWithMarkdown(
          `${emoji} *${title}*\n\nNo products available right now.`,
          Markup.inlineKeyboard([[Markup.button.callback('🏠 Main Menu', 'main_menu')]]),
        );
      }
      return;
    }
    try {
      await ctx.editMessageText(`${emoji} *${title}* — ${products.length} item(s):`, { parse_mode: 'Markdown' });
    } catch { /* ignore */ }

    for (const product of products) {
      const text =
        `${emoji} *${product.name}*\n` +
        `💰 Price: $${product.price.toFixed(2)}\n` +
        (product.description ? `📝 ${product.description}` : '');
      const buttons: any[][] = [[Markup.button.callback('🛒 Add to Cart', `add_to_cart:${product._id}`)]];
      if (user.role === UserRole.MANAGER || user.role === UserRole.SELLER) {
        buttons.push([
          Markup.button.callback(
            product.isActive ? '🔴 Deactivate' : '🟢 Activate',
            `toggle_product:${product._id}`,
          ),
        ]);
      }
      if (product.image) {
        try {
          await ctx.replyWithPhoto(product.image, { caption: text, parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
          continue;
        } catch { /* fallthrough to text */ }
      }
      await ctx.replyWithMarkdown(text, Markup.inlineKeyboard(buttons));
    }
    await ctx.reply('← Navigate', Markup.inlineKeyboard([[Markup.button.callback('🏠 Main Menu', 'main_menu')]]));
  }

  private async startAddProductWizard(ctx: Context) {
    const chatId = ctx.from?.id;
    if (!chatId) return;
    const user = await this.userModel.findOne({ chatId });
    if (!user || (user.role !== UserRole.MANAGER && user.role !== UserRole.SELLER)) {
      await ctx.reply('❌ Only managers and sellers can add products.');
      return;
    }
    this.wizardStates.set(chatId, { step: 'name' });
    await ctx.reply('➕ *Add New Product*\n\nStep 1/5: Enter the product name:', { parse_mode: 'Markdown' });
  }

  private async handleWizardText(ctx: Context, state: ProductWizardState) {
    const chatId = ctx.from?.id;
    const text = (ctx.message as Message.TextMessage)?.text;
    if (!chatId || !text) return;
    switch (state.step) {
      case 'name':
        state.name = text;
        state.step = 'price';
        this.wizardStates.set(chatId, state);
        await ctx.reply('Step 2/5: Enter the price (e.g. 9.99):');
        break;
      case 'price': {
        const price = parseFloat(text);
        if (isNaN(price) || price <= 0) { await ctx.reply('❌ Invalid price. Enter a valid number:'); return; }
        state.price = price;
        state.step = 'description';
        this.wizardStates.set(chatId, state);
        await ctx.reply('Step 3/5: Enter a description (or "skip"):');
        break;
      }
      case 'description':
        state.description = text.toLowerCase() === 'skip' ? undefined : text;
        state.step = 'image';
        this.wizardStates.set(chatId, state);
        await ctx.reply('Step 4/5: Send a photo URL (or "skip"):');
        break;
      case 'image':
        state.image = text.toLowerCase() === 'skip' ? undefined : text;
        state.step = 'category';
        this.wizardStates.set(chatId, state);
        await ctx.reply('Step 5/5: Select a category:', Markup.inlineKeyboard([
          [
            Markup.button.callback('🍔 Food', 'set_category:food'),
            Markup.button.callback('🥤 Drinks', 'set_category:drinks'),
            Markup.button.callback('🍰 Desserts', 'set_category:desserts'),
          ],
        ]));
        break;
      default:
        break;
    }
  }

  private async handleWizardCategorySelect(ctx: Context, category: ProductCategory) {
    const chatId = ctx.from?.id;
    if (!chatId) return;
    const state = this.wizardStates.get(chatId);
    if (!state || state.step !== 'category') {
      await ctx.reply('No active product creation. Use ➕ Add Product from the menu.');
      return;
    }
    this.wizardStates.delete(chatId);
    const product = await this.productModel.create({
      name: state.name,
      price: state.price,
      description: state.description,
      image: state.image,
      category,
      isActive: true,
      createdBy: chatId,
    });
    await ctx.editMessageText(
      `✅ *Product Created!*\n\n📦 *${product.name}*\n💰 $${product.price.toFixed(2)}\n🏷️ ${product.category}` +
      (product.description ? `\n📝 ${product.description}` : ''),
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🏠 Main Menu', 'main_menu')],
          [Markup.button.callback('➕ Add Another', 'add_product')],
        ]),
      },
    );
  }

  private async handleToggleProduct(ctx: Context, productId: string) {
    const chatId = ctx.from?.id;
    if (!chatId) return;
    const user = await this.userModel.findOne({ chatId });
    if (!user || (user.role !== UserRole.MANAGER && user.role !== UserRole.SELLER)) {
      await ctx.reply('❌ Unauthorized.'); return;
    }
    const product = await this.productModel.findById(productId);
    if (!product) { await ctx.reply('❌ Product not found.'); return; }
    product.isActive = !product.isActive;
    await product.save();
    await ctx.reply(`✅ "${product.name}" is now ${product.isActive ? 'ACTIVE 🟢' : 'INACTIVE 🔴'}.`);
  }

  async findById(productId: string): Promise<ProductDocument | null> {
    return this.productModel.findById(productId);
  }
}
