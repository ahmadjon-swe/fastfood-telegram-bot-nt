import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type UserDocument = User & Document;

export enum UserRole {
  CUSTOMER = 'customer',
  SELLER = 'seller',
  MANAGER = 'manager',
}

export enum RegistrationStep {
  NONE = 'none',
  AWAITING_PHONE = 'awaiting_phone',
  AWAITING_LOCATION = 'awaiting_location',
  COMPLETE = 'complete',
}

@Schema({ timestamps: true })
export class User {
  @Prop({ required: true, unique: true })
  chatId: number;

  @Prop({ required: true })
  firstName: string;

  @Prop()
  lastName?: string;

  @Prop()
  username?: string;

  @Prop()
  phone?: string;

  @Prop({ type: Object })
  location?: {
    latitude: number;
    longitude: number;
  };

  @Prop({ type: String, enum: UserRole, default: UserRole.CUSTOMER })
  role: UserRole;

  @Prop({ type: String, enum: RegistrationStep, default: RegistrationStep.AWAITING_PHONE })
  registrationStep: RegistrationStep;

  @Prop({ default: 0 })
  balance: number;

  @Prop({ default: true })
  isActive: boolean;
}

export const UserSchema = SchemaFactory.createForClass(User);
