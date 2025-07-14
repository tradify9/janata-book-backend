const express = require('express');
const axios = require('axios');
const cors = require('cors');
const winston = require('winston');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Configure Winston logger
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' }),
        new winston.transports.Console()
    ]
});

// Middleware to enable CORS for all origins
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
// Root route
app.get('/', (req, res) => {
  res.status(200).send('Server is running');
});

// Middleware to parse JSON bodies
app.use(express.json());

// Shiprocket API configuration
const shiprocketConfig = {
    token: process.env.SHIPROCKET_TOKEN || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOjY5OTkwMzAsInNvdXJjZSI6InNyLWF1dGgtaW50IiwiZXhwIjoxNzUzMzQ3ODEyLCJqdGkiOiJKVEM1VU9qN1BqdmNLd1BHIiwiaWF0IjoxNzUyNDgzODEyLCJpc3MiOiJodHRwczovL3NyLWF1dGguc2hpcHJvY2tldC5pbi9hdXRob3JpemUvdXNlciIsIm5iZiI6MTc1MjQ4MzgxMiwiY2lkIjozNzA0OTkwLCJ0YyI6MzYwLCJ2ZXJib3NlIjpmYWxzZSwidmVuZG9yX2lkIjowLCJ2ZW5kb3JfY29kZSI6Indvb2NvbW1lcmNlIn0.fTkwxL7wJOFXWhsS-eHG7kTnsnWRGazZ5RdLwBZbnBk',
    apiUrl: 'https://apiv2.shiprocket.in'
};

// Health check endpoint
app.get('/health', (req, res) => {
    logger.info('Health check endpoint called');
    res.status(200).json({ status: 'OK', message: 'Server is running' });
});

// Endpoint to handle order creation
app.post('/api/create-order', async (req, res) => {
    try {
        const {
            orderId,
            cart,
            formData,
            totalAmount,
            shippingCost,
            couponDiscount,
            paymentId,
            deliveryDays
        } = req.body;

        // Validate required fields
        if (!orderId || !cart || !Array.isArray(cart) || cart.length === 0 || !formData || !paymentId) {
            logger.error('Invalid order data received', {
                orderId,
                cartLength: cart?.length,
                formData,
                totalAmount,
                paymentId
            });
            return res.status(400).json({ success: false, error: 'Missing required order data' });
        }

        // Validate formData fields
        if (!formData.name || !formData.email || !formData.phone || !formData.address || !formData.pincode || !formData.state) {
            logger.error('Incomplete form data', { formData });
            return res.status(400).json({ success: false, error: 'Incomplete shipping details' });
        }

        // Validate cart items
        const invalidItem = cart.find(item => !item.id || !item.name || !Number.isFinite(item.price) || !Number.isFinite(item.quantity) || item.quantity <= 0);
        if (invalidItem) {
            logger.error('Invalid cart item detected', { invalidItem });
            return res.status(400).json({ success: false, error: 'Invalid cart item data' });
        }

        // Validate totalAmount (allow positive or zero with warning)
        if (!Number.isFinite(totalAmount) || totalAmount < 0) {
            logger.error('Invalid total amount', { totalAmount });
            return res.status(400).json({ success: false, error: 'Total amount must be a valid non-negative number' });
        }
        if (totalAmount === 0) {
            logger.warn('Total amount is zero, proceeding with warning', { orderId, totalAmount });
        }

        // Prepare order items for Shiprocket
        const orderItems = cart.map(item => ({
            name: item.name,
            sku: `SKU-${item.id}`,
            units: item.quantity,
            selling_price: item.price,
            discount: 0,
            tax: 0,
            hsn: '4901' // Assuming books
        }));

        // Log cart details for debugging
        logger.info('Cart details', { cart, orderItems });

        // Prepare Shiprocket payload
        const orderDate = new Date().toISOString().split('T')[0];
        const payload = {
            order_id: orderId,
            order_date: orderDate,
            pickup_location: process.env.SHIPROCKET_PICKUP_LOCATION || 'Primary',
            channel_id: '',
            comment: 'Order from Janata Books Point',
            billing_customer_name: formData.name,
            billing_last_name: '',
            billing_address: formData.address,
            billing_city: formData.city || '',
            billing_pincode: formData.pincode,
            billing_state: formData.state,
            billing_country: 'India',
            billing_email: formData.email,
            billing_phone: formData.phone,
            shipping_is_billing: true,
            shipping_customer_name: formData.name,
            shipping_last_name: '',
            shipping_address: formData.address,
            shipping_city: formData.city || '',
            shipping_pincode: formData.pincode,
            shipping_country: 'India',
            shipping_state: formData.state,
            shipping_email: formData.email,
            shipping_phone: formData.phone,
            order_items: orderItems,
            payment_method: 'Prepaid',
            shipping_charges: shippingCost || 0,
            giftwrap_charges: 0,
            transaction_charges: 0,
            total_discount: couponDiscount || 0,
            sub_total: totalAmount,
            length: 30, // Adjust as needed
            breadth: 20,
            height: 5,
            weight: 0.5 * cart.reduce((sum, item) => sum + item.quantity, 0) // 0.5kg per book
        };

        logger.info('Sending order to Shiprocket', { orderId, totalAmount, itemCount: cart.length, payload });

        // Send request to Shiprocket API
        const response = await axios.post(
            `${shiprocketConfig.apiUrl}/v1/external/orders/create/adhoc`,
            payload,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${shiprocketConfig.token}`
                },
                timeout: 10000 // 10-second timeout
            }
        );

        logger.info('Shiprocket order created successfully', { orderId, shiprocketOrderId: response.data.order_id });

        // Return success response with Shiprocket order ID
        res.json({
            success: true,
            shiprocketOrderId: response.data.order_id,
            message: 'Order created successfully in Shiprocket'
        });
    } catch (error) {
        logger.error('Error creating Shiprocket order', {
            error: error.message,
            response: error.response ? {
                status: error.response.status,
                data: error.response.data
            } : null
        });

        // Handle specific Shiprocket errors
        if (error.response) {
            const { status, data } = error.response;
            if (status === 401) {
                return res.status(401).json({
                    success: false,
                    error: 'Shiprocket authentication failed',
                    details: 'Invalid or expired Shiprocket token'
                });
            }
            if (status === 422) {
                return res.status(422).json({
                    success: false,
                    error: 'Invalid order data for Shiprocket',
                    details: data
                });
            }
        }

        // General error response
        res.status(500).json({
            success: false,
            error: 'Failed to create order in Shiprocket',
            details: error.message
        });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    logger.error('Server error', { error: err.message, stack: err.stack });
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        details: err.message
    });
});

// Start the server
app.listen(port, () => {
    logger.info(`Server running on port ${port}`);
});