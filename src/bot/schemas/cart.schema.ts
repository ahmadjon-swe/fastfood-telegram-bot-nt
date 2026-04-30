import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type CartDocument = Cart & Document;

export class CartItem {
  productId: Types.ObjectId;
  name: string;
  price: number;
  quantity: number;
}

@Schema({ timestamps: true })
export class Cart {
  @Prop({ required: true, unique: true })
  chatId: number;

  @Prop({
    type: [
      {
        productId: { type: Types.ObjectId, ref: 'Product' },
        name: String,
        price: Number,
        quantity: { type: Number, default: 1 },
      },
    ],
    default: [],
  })
  items: CartItem[];

  @Prop({ default: 0 })
  total: number;
}

export const CartSchema = SchemaFactory.createForClass(Cart);
