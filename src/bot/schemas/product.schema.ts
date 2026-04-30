import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ProductDocument = Product & Document;

@Schema({ timestamps: true })
export class Product {
  @Prop({ required: true })
  name: string;

  @Prop({ required: true })
  price: number;

  @Prop()
  image?: string;

  @Prop()
  description?: string;

  @Prop({ required: true })
  category: string; // endi enum emas, erkin string

  @Prop({ default: true })
  isActive: boolean;

  @Prop({ required: true })
  createdBy: number;
}

export const ProductSchema = SchemaFactory.createForClass(Product);