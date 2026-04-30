import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type OrderDocument = Order & Document;

export enum OrderStatus {
  PENDING = 'pending',
  ACCEPTED = 'accepted',
  DELIVERED = 'delivered',
}

export class OrderItem {
  productId: Types.ObjectId;
  name: string;
  price: number;
  quantity: number;
}

@Schema({ timestamps: true })
export class Order {
  @Prop({ required: true })
  chatId: number;

  @Prop({ required: true })
  customerName: string;

  @Prop({
    type: [
      {
        productId: { type: Types.ObjectId, ref: 'Product' },
        name: String,
        price: Number,
        quantity: Number,
      },
    ],
    required: true,
  })
  items: OrderItem[];

  @Prop({ required: true })
  total: number;

  @Prop({ type: String, enum: OrderStatus, default: OrderStatus.PENDING })
  status: OrderStatus;

  @Prop({ type: Object })
  deliveryLocation?: {
    latitude: number;
    longitude: number;
  };

  @Prop()
  phone?: string;
}

export const OrderSchema = SchemaFactory.createForClass(Order);
