import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TelegrafModule } from 'nestjs-telegraf';
import { session } from 'telegraf';

// Schemas
import { User, UserSchema } from './schemas/user.schema';
import { Product, ProductSchema } from './schemas/product.schema';
import { Cart, CartSchema } from './schemas/cart.schema';
import { Order, OrderSchema } from './schemas//order.schema';

// Services
import { BotService } from './services/bot.service';
import { UserService } from './services/user.service';
import { ProductService } from './services/product.service';
import { CartService } from './services/cart.service';
import { OrderService } from './services/order.service';
import { ConfigModule, ConfigService } from '@nestjs/config';

console.log('RAW TOKEN:', JSON.stringify(process.env.TELEGRAM_BOT_TOKEN))
@Module({
  imports: [
    // Register Telegraf with the bot token
    // Handler registration order matters:
    //   1. UserService  — /start, phone, location (must register first)
    //   2. ProductService — category browsing, product wizard
    //   3. CartService  — add/remove/view cart
    //   4. OrderService — order flow, payment, status updates
    //   5. BotService   — help, balance, fallback message guard
    TelegrafModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        token: configService.get<string>('TELEGRAM_BOT_TOKEN'),
        middlewares: [session()],
      }),
    }),

    // Register all Mongoose models
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Product.name, schema: ProductSchema },
      { name: Cart.name, schema: CartSchema },
      { name: Order.name, schema: OrderSchema },
    ]),
  ],
  providers: [
    // Order of providers determines handler registration order
    UserService,
    ProductService,
    CartService,
    OrderService,
    BotService,
  ],
  exports: [UserService, ProductService, CartService, OrderService],
})
export class BotModule {}
